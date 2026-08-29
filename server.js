#!/usr/bin/env node
/**
 * VPS 探针服务端 —— 零依赖，node server.js 直接跑
 *
 * 环境变量:
 *   PORT   监听端口，默认 8790
 *   TOKEN  Agent 上报密钥，默认 mjj-token-change-me（部署时务必改掉）
 *
 * 接口:
 *   POST /api/report   Agent 上报（需请求头 X-Token: <TOKEN>）
 *   GET  /api/data     一次性 JSON 快照
 *   GET  /api/stream   SSE 实时推送，每 2 秒一帧
 *   GET  /             仪表盘页面 (public/)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8790;
const TOKEN = process.env.TOKEN || 'mjj-token-change-me';
const HISTORY_LEN = 60;      // 每台机器保留的采样点数（约等于 agent 间隔 x 60）
const OFFLINE_MS = 15000;    // 超过该时长未上报判定离线（agent 默认 5s 上报一次）
const MAX_BODY = 64 * 1024;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const SAVE_INTERVAL_MS = 30000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const servers = new Map();   // id -> 运行状态
const sseClients = new Set();

const PING_KEYS = ['pingCt', 'pingCu', 'pingCm'];

/* ---------------- Agent 上报处理 ---------------- */

function round2(n) { return Math.round(n * 100) / 100; }

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function emptyHist() {
  return { cpu: [], mem: [], netIn: [], netOut: [], pingCt: [], pingCu: [], pingCm: [] };
}

function upsertMachine(m) {
  const now = Date.now();
  let s = servers.get(m.id);
  if (!s) {
    s = {
      info: {},
      prev: null,                                   // 上一次的累计计数器，用于差分
      hist: emptyHist(),
      lastSeen: now,
      firstSeen: now,
      onlineMs: 0,        // 累计在线时长，用于算可用率
      totalMs: 0,
    };
    servers.set(m.id, s);
  }

  // 可用率统计：本次与上次上报的间隔，若在离线阈值内视为持续在线
  if (s.prev) {
    const gap = now - s.prev.t;
    s.totalMs += gap;
    if (gap < OFFLINE_MS) s.onlineMs += gap;
  }

  Object.assign(s.info, {
    name: String(m.name || m.id),
    os: String(m.os || ''),
    kernel: String(m.kernel || ''),
    virt: String(m.virt || ''),
    cpuModel: String(m.cpuModel || ''),
    cpuCount: numOr(m.cpuCount, 0),
    memUsed: numOr(m.memUsed, 0),
    memTotal: numOr(m.memTotal, 0),
    diskUsed: numOr(m.diskUsed, 0),
    diskTotal: numOr(m.diskTotal, 0),
    load1: round2(numOr(m.load1, 0)),
    uptime: numOr(m.uptime, 0),
    rxBytes: numOr(m.rxBytes, 0),                   // 累计值，开机以来流量
    txBytes: numOr(m.txBytes, 0),
    tcpConns: numOr(m.tcpConns, 0),
    // 三网延迟，ms；-1 表示超时。老版 agent 只发 ping 字段，兜底填到电信槽位
    pingCt: numOr(m.pingCt, numOr(m.ping, -1)),
    pingCu: numOr(m.pingCu, -1),
    pingCm: numOr(m.pingCm, -1),
  });

  // CPU / 网络速率全部由累计计数器差分得出，agent 端零计算
  let cpuPct = 0, inRate = 0, outRate = 0;
  if (s.prev) {
    const dIdle = numOr(m.cpuIdle, 0) - s.prev.cpuIdle;
    const dTotal = numOr(m.cpuTotal, 0) - s.prev.cpuTotal;
    if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));

    const dt = (now - s.prev.t) / 1000;
    if (dt > 0) {
      inRate = Math.max(0, (numOr(m.rxBytes, 0) - s.prev.rx) / dt);   // 计数器回绕/重启时差值为负，取 0
      outRate = Math.max(0, (numOr(m.txBytes, 0) - s.prev.tx) / dt);
    }
  }
  s.prev = {
    cpuIdle: numOr(m.cpuIdle, 0),
    cpuTotal: numOr(m.cpuTotal, 0),
    rx: numOr(m.rxBytes, 0),
    tx: numOr(m.txBytes, 0),
    t: now,
  };

  const memPct = s.info.memTotal > 0 ? (s.info.memUsed / s.info.memTotal) * 100 : 0;
  s.cpuPct = round2(cpuPct);
  s.memPct = round2(memPct);
  s.inRate = inRate;
  s.outRate = outRate;
  s.lastSeen = now;

  const samples = [
    ['cpu', s.cpuPct], ['mem', s.memPct],
    ['netIn', inRate], ['netOut', outRate],
  ];
  for (const k of PING_KEYS) samples.push([k, s.info[k]]);
  for (const [key, val] of samples) {
    const arr = s.hist[key];
    arr.push(val);
    if (arr.length > HISTORY_LEN) arr.shift();
  }
}

// 三网里取最优（最小有效）延迟，用于卡片主徽标与排序
function bestPing(info) {
  const vals = PING_KEYS.map((k) => info[k]).filter((v) => v >= 0);
  return vals.length ? Math.min(...vals) : -1;
}

function snapshot() {
  const now = Date.now();
  const list = [];
  for (const [id, s] of servers) {
    const online = now - s.lastSeen < OFFLINE_MS;
    list.push({
      id,
      ...s.info,
      ping: bestPing(s.info),
      cpuPct: s.cpuPct,
      memPct: s.memPct,
      inRate: round2(s.inRate),
      outRate: round2(s.outRate),
      online,
      lastSeenSec: Math.max(0, Math.round((now - s.lastSeen) / 1000)),
      uptimePct: s.totalMs > 0 ? round2((s.onlineMs / s.totalMs) * 100) : 100,
      hist: s.hist,
    });
  }
  // 在线优先，其次按名称稳定排序，避免卡片每帧跳位
  list.sort((a, b) => (a.online === b.online ? String(a.name).localeCompare(String(b.name), 'zh') : a.online ? -1 : 1));
  return { ts: now, machines: list };
}

/* ---------------- 状态持久化：重启不丢历史 ---------------- */

function saveState() {
  const out = [];
  for (const [id, s] of servers) {
    out.push({ id, info: s.info, hist: s.hist, lastSeen: s.lastSeen, firstSeen: s.firstSeen, onlineMs: s.onlineMs, totalMs: s.totalMs });
  }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 1, savedAt: Date.now(), machines: out }));
  } catch (e) {
    console.error('[probe] 状态保存失败:', e.message);
  }
}

function loadState() {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch (_) { return; }
  try {
    const data = JSON.parse(raw);
    for (const m of data.machines || []) {
      servers.set(m.id, {
        info: m.info || {},
        prev: null,                              // 计数器基线作废，首帧速率从 0 重新计算
        hist: Object.assign(emptyHist(), m.hist),
        lastSeen: m.lastSeen || 0,
        firstSeen: m.firstSeen || Date.now(),
        onlineMs: m.onlineMs || 0,
        totalMs: m.totalMs || 0,
        cpuPct: 0, memPct: 0, inRate: 0, outRate: 0,
      });
    }
    console.log(`[probe] 已从 ${STATE_FILE} 恢复 ${servers.size} 台机器的历史`);
  } catch (e) {
    console.error('[probe] 状态文件损坏，已忽略:', e.message);
  }
}


/* ---------------- SSE 广播 ---------------- */

function sseFrame() { return 'data: ' + JSON.stringify(snapshot()) + '\n\n'; }

setInterval(() => {
  if (sseClients.size === 0) return;
  const frame = sseFrame();
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) { sseClients.delete(res); }
  }
}, 2000);

/* ---------------- HTTP 服务 ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // CORS：仪表盘可以跨域部署在别的域名下
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Token',
    });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/report') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"bad token"}'); return; }
    try {
      const m = JSON.parse(await readBody(req));
      if (!m || !m.id) throw new Error('missing id');
      upsertMachine(m);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"bad payload"}');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(snapshot()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // nginx 反代下禁用缓冲，SSE 才是实时的
    });
    res.write(sseFrame());
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`[probe] 探针面板:      http://127.0.0.1:${PORT}/`);
  console.log(`[probe] Agent 上报:    POST http://<本机>:${PORT}/api/report  (X-Token: ${TOKEN})`);
  console.log(`[probe] 状态文件:      ${STATE_FILE}（每 ${SAVE_INTERVAL_MS / 1000}s 落盘，重启不丢历史）`);
  if (TOKEN === 'mjj-token-change-me') {
    console.warn('[probe] ⚠ 正在使用默认 TOKEN，公网部署务必改成 TOKEN=你的密钥');
  }
});

/* ---------------- 启动与退出 ---------------- */

loadState();
const saveTimer = setInterval(saveState, SAVE_INTERVAL_MS);

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n[probe] 收到 ${sig}，保存状态后退出`);
  clearInterval(saveTimer);
  saveState();
  for (const res of sseClients) { try { res.end(); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();   // 有长连接挂着时兜底强退
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

