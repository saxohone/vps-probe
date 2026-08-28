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

const PUBLIC_DIR = path.join(__dirname, 'public');
const servers = new Map();   // id -> 运行状态
const sseClients = new Set();

/* ---------------- Agent 上报处理 ---------------- */

function round2(n) { return Math.round(n * 100) / 100; }

function upsertMachine(m) {
  const now = Date.now();
  let s = servers.get(m.id);
  if (!s) {
    s = {
      info: {},
      prev: null,                                   // 上一次的累计计数器，用于差分
      hist: { cpu: [], mem: [], netIn: [], netOut: [], ping: [] },
      lastSeen: now,
      firstSeen: now,
    };
    servers.set(m.id, s);
  }

  Object.assign(s.info, {
    name: String(m.name || m.id),
    os: String(m.os || ''),
    kernel: String(m.kernel || ''),
    virt: String(m.virt || ''),
    cpuModel: String(m.cpuModel || ''),
    cpuCount: Number(m.cpuCount) || 0,
    memUsed: Number(m.memUsed) || 0,
    memTotal: Number(m.memTotal) || 0,
    diskUsed: Number(m.diskUsed) || 0,
    diskTotal: Number(m.diskTotal) || 0,
    load1: round2(Number(m.load1) || 0),
    uptime: Number(m.uptime) || 0,
    rxBytes: Number(m.rxBytes) || 0,                // 累计值，开机以来流量
    txBytes: Number(m.txBytes) || 0,
    ping: Number(m.ping),                           // ms，-1 表示超时
    tcpConns: Number(m.tcpConns) || 0,
  });

  // CPU / 网络速率全部由累计计数器差分得出，agent 端零计算
  let cpuPct = 0, inRate = 0, outRate = 0;
  if (s.prev) {
    const dIdle = Number(m.cpuIdle) - s.prev.cpuIdle;
    const dTotal = Number(m.cpuTotal) - s.prev.cpuTotal;
    if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));

    const dt = (now - s.prev.t) / 1000;
    if (dt > 0) {
      inRate = Math.max(0, (Number(m.rxBytes) - s.prev.rx) / dt);   // 计数器回绕/重启时差值为负，取 0
      outRate = Math.max(0, (Number(m.txBytes) - s.prev.tx) / dt);
    }
  }
  s.prev = {
    cpuIdle: Number(m.cpuIdle) || 0,
    cpuTotal: Number(m.cpuTotal) || 0,
    rx: Number(m.rxBytes) || 0,
    tx: Number(m.txBytes) || 0,
    t: now,
  };

  const memPct = s.info.memTotal > 0 ? (s.info.memUsed / s.info.memTotal) * 100 : 0;
  s.cpuPct = round2(cpuPct);
  s.memPct = round2(memPct);
  s.inRate = inRate;
  s.outRate = outRate;
  s.lastSeen = now;

  for (const [key, val] of [
    ['cpu', s.cpuPct], ['mem', s.memPct],
    ['netIn', inRate], ['netOut', outRate],
    ['ping', Number.isFinite(s.info.ping) ? s.info.ping : -1],
  ]) {
    const arr = s.hist[key];
    arr.push(val);
    if (arr.length > HISTORY_LEN) arr.shift();
  }
}

function snapshot() {
  const now = Date.now();
  const list = [];
  for (const [id, s] of servers) {
    list.push({
      id,
      ...s.info,
      cpuPct: s.cpuPct,
      memPct: s.memPct,
      inRate: round2(s.inRate),
      outRate: round2(s.outRate),
      ping: Number.isFinite(s.info.ping) ? s.info.ping : -1,
      online: now - s.lastSeen < OFFLINE_MS,
      lastSeenSec: Math.max(0, Math.round((now - s.lastSeen) / 1000)),
      hist: s.hist,
    });
  }
  // 在线优先，其余按最后上报时间倒序
  list.sort((a, b) => (a.online === b.online ? b.lastSeenSec * -1 - a.lastSeenSec * -1 : a.online ? -1 : 1));
  return { ts: now, machines: list };
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
  console.log(`[probe] 提示: 生产环境用环境变量 TOKEN=xxx PORT=xxx 覆盖默认值`);
});
