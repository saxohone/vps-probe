#!/usr/bin/env node
/**
 * VPS 探针服务端 —— 零依赖，node server.js 直接跑
 *
 * 环境变量:
 *   PORT             监听端口，默认 8790
 *   TOKEN            Agent 上报密钥，默认 mjj-token-change-me（部署时务必改掉）
 *   ADMIN_PASSWORD   管理员面板密码，默认 admin（部署时务必改掉）
 *   PUBLIC_URL       对外访问地址，用于生成安装命令，如 https://probe.example.com
 *   STATE_FILE       运行状态存档路径，默认同目录 state.json
 *   CONFIG_FILE      探测目标/机器备注存档，默认同目录 config.json
 *
 * 公开接口:
 *   GET  /                仪表盘
 *   GET  /admin           管理员面板
 *   GET  /agent.sh        Agent 脚本（供 VPS curl 安装）
 *   GET  /api/data        一次性 JSON 快照
 *   GET  /api/stream      SSE 实时推送
 *
 * Agent 接口（需请求头 X-Token）:
 *   POST /api/report      上报指标
 *   GET  /api/targets     拉取探测目标列表（TSV，便于 bash 解析）
 *
 * 管理接口（需登录会话）:
 *   POST /api/admin/login | /logout
 *   GET  /api/admin/config
 *   POST /api/admin/target/save | /target/delete
 *   POST /api/admin/machine/save | /machine/delete
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8790;
const TOKEN = process.env.TOKEN || 'mjj-token-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// 只读接口的跨域白名单，逗号分隔，如 https://a.com,https://b.com；留空则仅同源
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const HISTORY_LEN = 60;        // 每台机器每项指标保留的采样点数
const OFFLINE_MS = 15000;      // 超过该时长未上报判定离线
const MAX_BODY = 64 * 1024;
const SAVE_INTERVAL_MS = 30000;
const SESSION_TTL_MS = 8 * 3600 * 1000;
const LOGIN_MAX_FAILS = 8;     // 同一 IP 连续失败上限
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const __DIR = __dirname;
const PUBLIC_DIR = path.join(__DIR, 'public');
const STATE_FILE = process.env.STATE_FILE || path.join(__DIR, 'state.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__DIR, 'config.json');
const AGENT_FILE = path.join(__DIR, 'agent.sh');

const servers = new Map();     // machineId -> 运行状态
const sseClients = new Set();
const sessions = new Map();    // sessionId -> expiresAt
const loginFails = new Map();  // ip -> { n, until }

/* ================= 探测目标配置 ================= */

const DEFAULT_TARGETS = [
  { id: 'ct', label: '电信', host: '219.141.136.12', port: 80, color: '#38bdf8' },
  { id: 'cu', label: '联通', host: '202.106.50.1', port: 80, color: '#fb923c' },
  { id: 'cm', label: '移动', host: '221.179.155.161', port: 80, color: '#a78bfa' },
];

let config = { targets: DEFAULT_TARGETS.slice(), machines: {} };

/**
 * 校验探测目标主机：只允许公网可路由的 IP 或普通域名。
 * 拒绝环回、私网、链路本地、CGNAT、组播、保留段以及 localhost 等本机别名，
 * 防止把面板当成内网/云元数据的探测跳板。
 */
function validateTargetHost(raw) {
  let host = String(raw || '').trim().toLowerCase();
  if (!host || host.length > 253) return { ok: false, why: '主机名为空或过长' };

  // IPv6 先判：字面量含 2 个以上冒号，可带方括号。
  // 只有一个冒号的按「误填了 host:port」处理，走下面的非法字符检查。
  const bracketed = /^\[.*\]$/.test(host);
  if (bracketed) host = host.slice(1, -1);
  if (bracketed || (host.match(/:/g) || []).length >= 2) {
    if (host === '::1' || host === '::') return { ok: false, why: 'IPv6 环回/未指定地址' };
    if (/^f[cd]/.test(host)) return { ok: false, why: 'fc00::/7 为 IPv6 唯一本地地址' };
    if (/^fe[89ab]/.test(host)) return { ok: false, why: 'fe80::/10 为 IPv6 链路本地地址' };
    if (/^ff/.test(host)) return { ok: false, why: 'ff00::/8 为 IPv6 组播地址' };
    if (/^::ffff:/.test(host)) return { ok: false, why: '不允许 IPv4 映射地址（请直接填 IPv4）' };
    if (!/^[0-9a-f:]+$/.test(host)) return { ok: false, why: 'IPv6 格式非法' };
    return { ok: true, host };
  }

  if (/[\s/\\?#@:]/.test(host)) return { ok: false, why: '主机名含非法字符（不要带协议、端口或路径）' };

  const banned = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'metadata', 'metadata.google.internal']);
  if (banned.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, why: '不允许本机/内网保留域名' };
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return { ok: false, why: 'IPv4 段超出范围' };
    const [a, b] = o;
    if (a === 0) return { ok: false, why: '0.0.0.0/8 为保留地址' };
    if (a === 10) return { ok: false, why: '10.0.0.0/8 为私有地址' };
    if (a === 127) return { ok: false, why: '127.0.0.0/8 为环回地址' };
    if (a === 169 && b === 254) return { ok: false, why: '169.254.0.0/16 为链路本地地址（含云元数据）' };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, why: '172.16.0.0/12 为私有地址' };
    if (a === 192 && b === 168) return { ok: false, why: '192.168.0.0/16 为私有地址' };
    if (a === 100 && b >= 64 && b <= 127) return { ok: false, why: '100.64.0.0/10 为 CGNAT 地址' };
    if (a === 192 && b === 0) return { ok: false, why: '192.0.0.0/24 为协议保留地址' };
    if (a >= 224) return { ok: false, why: '224.0.0.0/4 及以上为组播/保留地址' };
    return { ok: true, host };
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, why: '域名格式非法（需形如 example.com）' };
  }
  return { ok: true, host };
}

function sanitizeTarget(t) {
  const id = String(t.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16);
  if (!id) return { err: '目标 ID 只能含小写字母、数字、下划线' };
  const label = String(t.label || id).trim().slice(0, 12) || id;
  const port = Number(t.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { err: '端口需为 1-65535 的整数' };
  const v = validateTargetHost(t.host);
  if (!v.ok) return { err: v.why };
  const color = /^#[0-9a-fA-F]{6}$/.test(String(t.color || '')) ? String(t.color) : '#38bdf8';
  return { target: { id, label, host: v.host, port, color } };
}

function loadConfig() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (_) { return; }
  try {
    const d = JSON.parse(raw);
    const targets = [];
    for (const t of d.targets || []) {
      const r = sanitizeTarget(t);
      if (r.target && !targets.some((x) => x.id === r.target.id)) targets.push(r.target);
    }
    if (targets.length) config.targets = targets;
    if (d.machines && typeof d.machines === 'object') config.machines = d.machines;
    console.log(`[probe] 已加载配置：${config.targets.length} 个探测目标`);
  } catch (e) {
    console.error('[probe] 配置文件损坏，使用默认目标:', e.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ v: 1, targets: config.targets, machines: config.machines }, null, 2));
  } catch (e) {
    console.error('[probe] 配置保存失败:', e.message);
  }
}

/* ================= 国家 / 国旗 ================= */

// ISO 3166-1 alpha-2 -> 中文名。Agent 只上报两位码，国旗由码位计算得出。
const COUNTRY_NAMES = {
  CN: '中国', HK: '香港', TW: '台湾', MO: '澳门', JP: '日本', KR: '韩国', SG: '新加坡',
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利',
  GB: '英国', DE: '德国', FR: '法国', NL: '荷兰', BE: '比利时', LU: '卢森堡',
  IT: '意大利', ES: '西班牙', PT: '葡萄牙', CH: '瑞士', AT: '奥地利', IE: '爱尔兰',
  SE: '瑞典', NO: '挪威', FI: '芬兰', DK: '丹麦', IS: '冰岛', PL: '波兰',
  CZ: '捷克', SK: '斯洛伐克', HU: '匈牙利', RO: '罗马尼亚', BG: '保加利亚',
  RU: '俄罗斯', UA: '乌克兰', BY: '白俄罗斯', LT: '立陶宛', LV: '拉脱维亚', EE: '爱沙尼亚',
  MD: '摩尔多瓦', RS: '塞尔维亚', HR: '克罗地亚', SI: '斯洛文尼亚', GR: '希腊',
  TR: '土耳其', IL: '以色列', AE: '阿联酋', SA: '沙特', QA: '卡塔尔', KW: '科威特',
  IN: '印度', PK: '巴基斯坦', BD: '孟加拉', LK: '斯里兰卡', NP: '尼泊尔',
  TH: '泰国', VN: '越南', MY: '马来西亚', ID: '印尼', PH: '菲律宾', KH: '柬埔寨',
  MM: '缅甸', LA: '老挝', BN: '文莱', MN: '蒙古', KZ: '哈萨克斯坦', UZ: '乌兹别克斯坦',
  AU: '澳大利亚', NZ: '新西兰', ZA: '南非', EG: '埃及', NG: '尼日利亚', KE: '肯尼亚',
  MA: '摩洛哥', DZ: '阿尔及利亚', TN: '突尼斯', GH: '加纳', ET: '埃塞俄比亚',
  CO: '哥伦比亚', PE: '秘鲁', VE: '委内瑞拉', UY: '乌拉圭', PY: '巴拉圭', BO: '玻利维亚',
  CR: '哥斯达黎加', PA: '巴拿马', GT: '危地马拉', DO: '多米尼加', CU: '古巴',
  CY: '塞浦路斯', MT: '马耳他', AL: '阿尔巴尼亚', MK: '北马其顿', BA: '波黑', GE: '格鲁吉亚',
  AM: '亚美尼亚', AZ: '阿塞拜疆', IR: '伊朗', IQ: '伊拉克', JO: '约旦', LB: '黎巴嫩',
};

function normCountry(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : '';
}

// 两位国家码转 emoji 国旗：A->🇦 的区域指示符偏移
function flagOf(cc) {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65, 0x1f1e6 + cc.charCodeAt(1) - 65);
}

/* ================= Agent 上报处理 ================= */

function round2(n) { return Math.round(n * 100) / 100; }
function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function emptyHist() {
  const h = { cpu: [], mem: [], netIn: [], netOut: [] };
  for (const t of config.targets) h['p_' + t.id] = [];
  return h;
}

function histKeyFor(id) { return 'p_' + id; }

function upsertMachine(m) {
  const now = Date.now();
  let s = servers.get(m.id);
  if (!s) {
    s = {
      info: {}, pings: {}, prev: null, hist: emptyHist(),
      lastSeen: now, firstSeen: now, onlineMs: 0, totalMs: 0,
    };
    servers.set(m.id, s);
  }

  // 可用率：本次与上次上报的间隔，落在离线阈值内视为持续在线
  if (s.prev) {
    const gap = now - s.prev.t;
    s.totalMs += gap;
    if (gap < OFFLINE_MS) s.onlineMs += gap;
  }

  const override = config.machines[m.id] || {};
  Object.assign(s.info, {
    name: String(override.name || m.name || m.id).slice(0, 40),
    country: normCountry(override.country || m.country),
    os: String(m.os || '').slice(0, 60),
    kernel: String(m.kernel || '').slice(0, 40),
    virt: String(m.virt || '').slice(0, 20),
    cpuModel: String(m.cpuModel || '').slice(0, 60),
    cpuCount: numOr(m.cpuCount, 0),
    memUsed: numOr(m.memUsed, 0),
    memTotal: numOr(m.memTotal, 0),
    diskUsed: numOr(m.diskUsed, 0),
    diskTotal: numOr(m.diskTotal, 0),
    load1: round2(numOr(m.load1, 0)),
    uptime: numOr(m.uptime, 0),
    rxBytes: numOr(m.rxBytes, 0),
    txBytes: numOr(m.txBytes, 0),
    tcpConns: numOr(m.tcpConns, 0),
    agentVer: String(m.agentVer || '').slice(0, 16),
  });

  // 延迟按目标 id 动态收取；agent 发的是 { pings: { ct: 12.3, cu: -1 } }
  const incoming = (m.pings && typeof m.pings === 'object') ? m.pings : {};
  s.pings = {};
  for (const t of config.targets) {
    s.pings[t.id] = numOr(incoming[t.id], -1);
  }

  // CPU / 网络速率由累计计数器差分得出
  let cpuPct = 0, inRate = 0, outRate = 0;
  if (s.prev) {
    const dIdle = numOr(m.cpuIdle, 0) - s.prev.cpuIdle;
    const dTotal = numOr(m.cpuTotal, 0) - s.prev.cpuTotal;
    if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
    const dt = (now - s.prev.t) / 1000;
    if (dt > 0) {
      inRate = Math.max(0, (numOr(m.rxBytes, 0) - s.prev.rx) / dt);
      outRate = Math.max(0, (numOr(m.txBytes, 0) - s.prev.tx) / dt);
    }
  }
  s.prev = {
    cpuIdle: numOr(m.cpuIdle, 0), cpuTotal: numOr(m.cpuTotal, 0),
    rx: numOr(m.rxBytes, 0), tx: numOr(m.txBytes, 0), t: now,
  };

  s.cpuPct = round2(cpuPct);
  s.memPct = round2(s.info.memTotal > 0 ? (s.info.memUsed / s.info.memTotal) * 100 : 0);
  s.inRate = inRate;
  s.outRate = outRate;
  s.lastSeen = now;

  const samples = [['cpu', s.cpuPct], ['mem', s.memPct], ['netIn', inRate], ['netOut', outRate]];
  for (const t of config.targets) samples.push([histKeyFor(t.id), s.pings[t.id]]);
  for (const [key, val] of samples) {
    if (!s.hist[key]) s.hist[key] = [];
    s.hist[key].push(val);
    if (s.hist[key].length > HISTORY_LEN) s.hist[key].shift();
  }
}

function bestPing(pings) {
  const vals = config.targets.map((t) => pings[t.id]).filter((v) => v >= 0);
  return vals.length ? Math.min(...vals) : -1;
}

function snapshot() {
  const now = Date.now();
  const machines = [];
  for (const [id, s] of servers) {
    const cc = s.info.country;
    machines.push({
      id,
      ...s.info,
      flag: flagOf(cc),
      countryName: COUNTRY_NAMES[cc] || (cc || ''),
      pings: s.pings,
      ping: bestPing(s.pings),
      cpuPct: s.cpuPct, memPct: s.memPct,
      inRate: round2(s.inRate), outRate: round2(s.outRate),
      online: now - s.lastSeen < OFFLINE_MS,
      lastSeenSec: Math.max(0, Math.round((now - s.lastSeen) / 1000)),
      uptimePct: s.totalMs > 0 ? round2((s.onlineMs / s.totalMs) * 100) : 100,
      hist: s.hist,
    });
  }
  machines.sort((a, b) => (a.online === b.online
    ? String(a.name).localeCompare(String(b.name), 'zh')
    : a.online ? -1 : 1));
  return { ts: now, targets: config.targets, machines };
}

/* ================= 状态持久化 ================= */

function saveState() {
  const out = [];
  for (const [id, s] of servers) {
    out.push({ id, info: s.info, pings: s.pings, hist: s.hist, lastSeen: s.lastSeen, firstSeen: s.firstSeen, onlineMs: s.onlineMs, totalMs: s.totalMs });
  }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 2, savedAt: Date.now(), machines: out }));
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
        pings: m.pings || {},
        prev: null,                  // 计数器基线作废，首帧速率从 0 重算
        hist: Object.assign(emptyHist(), m.hist),
        lastSeen: m.lastSeen || 0,
        firstSeen: m.firstSeen || Date.now(),
        onlineMs: m.onlineMs || 0,
        totalMs: m.totalMs || 0,
        cpuPct: 0, memPct: 0, inRate: 0, outRate: 0,
      });
    }
    console.log(`[probe] 已恢复 ${servers.size} 台机器的历史`);
  } catch (e) {
    console.error('[probe] 状态文件损坏，已忽略:', e.message);
  }
}

/* ================= 管理员会话 ================= */

function clientIp(req) {
  return String(req.socket.remoteAddress || 'unknown');
}

function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { loginFails.delete(ip); return false; }
  return rec.n >= LOGIN_MAX_FAILS;
}

function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  rec.until = Date.now() + LOGIN_WINDOW_MS;
  loginFails.set(ip, rec);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function newSession() {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return sid;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAdmin(req) {
  const sid = parseCookies(req).probe_sid;
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(sid); return false; }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, exp] of sessions) if (now > exp) sessions.delete(sid);
}, 600000).unref();

/* ================= SSE 广播 ================= */

function sseFrame() { return 'data: ' + JSON.stringify(snapshot()) + '\n\n'; }

setInterval(() => {
  if (sseClients.size === 0) return;
  const frame = sseFrame();
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) { sseClients.delete(res); }
  }
}, 2000);

/* ================= HTTP 工具 ================= */

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

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
}

/**
 * 只读数据接口的跨域放行：默认同源，仅当显式配置 ALLOWED_ORIGINS 时按白名单回显。
 * 不用通配符，避免任意站点读取面板数据。
 */
function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin) return;                        // 同源请求不带 Origin
  if (!ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
}

// 生成 Agent 安装命令：优先用 PUBLIC_URL，否则回落到请求里的 Host
function baseUrlOf(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers.host || `127.0.0.1:${PORT}`);
  return `${proto}://${host}`;
}

function installCommand(req, displayName, country) {
  const base = baseUrlOf(req);
  const name = displayName ? ` "${displayName}"` : '';
  const cc = country ? ` ${country}` : '';
  return `curl -sL ${base}/agent.sh -o agent.sh && chmod +x agent.sh && ` +
    `nohup ./agent.sh ${base} ${TOKEN}${name}${cc} >/dev/null 2>&1 &`;
}

/* ================= 路由 ================= */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Token',
    });
    return res.end();
  }

  /* ---- Agent 接口 ---- */

  if (req.method === 'POST' && p === '/api/report') {
    if (!safeEqual(req.headers['x-token'] || '', TOKEN)) return sendJson(res, 401, { ok: false, error: 'bad token' });
    try {
      const m = JSON.parse(await readBody(req));
      if (!m || !m.id) throw new Error('missing id');
      upsertMachine(m);
      sendJson(res, 200, { ok: true });
    } catch (_) {
      sendJson(res, 400, { ok: false, error: 'bad payload' });
    }
    return;
  }

  // Agent 每轮拉取探测目标；TSV 让 bash 用 while read 直接吃
  if (req.method === 'GET' && p === '/api/targets') {
    if (!safeEqual(req.headers['x-token'] || '', TOKEN)) return sendJson(res, 401, { ok: false, error: 'bad token' });
    const tsv = config.targets.map((t) => [t.id, t.host, t.port].join('\t')).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(tsv + (tsv ? '\n' : ''));
  }

  // 托管 agent.sh，方便 VPS 一条 curl 装好
  if (req.method === 'GET' && p === '/agent.sh') {
    return fs.readFile(AGENT_FILE, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('agent.sh not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' }).end(data);
    });
  }

  /* ---- 公开数据 ---- */

  if (req.method === 'GET' && p === '/api/data') {
    applyCors(req, res);
    return sendJson(res, 200, snapshot());
  }

  if (req.method === 'GET' && p === '/api/stream') {
    applyCors(req, res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',    // nginx 反代下禁用缓冲，SSE 才实时
    });
    res.write(sseFrame());
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  /* ---- 管理接口 ---- */

  if (req.method === 'POST' && p === '/api/admin/login') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return sendJson(res, 429, { ok: false, error: '失败次数过多，请 10 分钟后再试' });
    let pw = '';
    try { pw = String(JSON.parse(await readBody(req)).password || ''); } catch (_) {}
    if (!safeEqual(pw, ADMIN_PASSWORD)) {
      noteLoginFail(ip);
      return sendJson(res, 401, { ok: false, error: '密码错误' });
    }
    loginFails.delete(ip);
    const sid = newSession();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `probe_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && p === '/api/admin/logout') {
    const sid = parseCookies(req).probe_sid;
    if (sid) sessions.delete(sid);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'probe_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: '未登录' });

    if (req.method === 'GET' && p === '/api/admin/config') {
      const snap = snapshot();
      return sendJson(res, 200, {
        ok: true,
        targets: config.targets,
        machines: snap.machines.map((m) => ({
          id: m.id, name: m.name, country: m.country, flag: m.flag, countryName: m.countryName,
          online: m.online, lastSeenSec: m.lastSeenSec, os: m.os,
        })),
        countries: COUNTRY_NAMES,
        install: installCommand(req, '', ''),
        baseUrl: baseUrlOf(req),
        token: TOKEN,
        defaultPasswordInUse: ADMIN_PASSWORD === 'admin',
      });
    }

    if (req.method === 'POST' && p === '/api/admin/install') {
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const name = String(b.name || '').slice(0, 40).replace(/"/g, '');
      const cc = normCountry(b.country);
      return sendJson(res, 200, { ok: true, command: installCommand(req, name, cc) });
    }

    if (req.method === 'POST' && p === '/api/admin/target/save') {
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const r = sanitizeTarget(b);
      if (r.err) return sendJson(res, 400, { ok: false, error: r.err });
      const i = config.targets.findIndex((t) => t.id === r.target.id);
      if (i >= 0) config.targets[i] = r.target;
      else {
        if (config.targets.length >= 6) return sendJson(res, 400, { ok: false, error: '最多 6 个探测目标' });
        config.targets.push(r.target);
      }
      // 新目标要给已有机器补上历史槽位，否则前端读不到数组
      for (const s of servers.values()) if (!s.hist[histKeyFor(r.target.id)]) s.hist[histKeyFor(r.target.id)] = [];
      saveConfig();
      return sendJson(res, 200, { ok: true, targets: config.targets });
    }

    if (req.method === 'POST' && p === '/api/admin/target/delete') {
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const id = String(b.id || '');
      if (config.targets.length <= 1) return sendJson(res, 400, { ok: false, error: '至少保留 1 个探测目标' });
      const before = config.targets.length;
      config.targets = config.targets.filter((t) => t.id !== id);
      if (config.targets.length === before) return sendJson(res, 404, { ok: false, error: '目标不存在' });
      for (const s of servers.values()) { delete s.hist[histKeyFor(id)]; delete s.pings[id]; }
      saveConfig();
      return sendJson(res, 200, { ok: true, targets: config.targets });
    }

    if (req.method === 'POST' && p === '/api/admin/machine/save') {
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const id = String(b.id || '');
      if (!servers.has(id)) return sendJson(res, 404, { ok: false, error: '机器不存在' });
      const entry = {};
      if (b.name) entry.name = String(b.name).slice(0, 40);
      const cc = normCountry(b.country);
      if (cc) entry.country = cc;
      config.machines[id] = entry;
      const s = servers.get(id);
      if (entry.name) s.info.name = entry.name;
      if (entry.country) s.info.country = entry.country;
      saveConfig();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/machine/delete') {
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const id = String(b.id || '');
      if (!servers.delete(id)) return sendJson(res, 404, { ok: false, error: '机器不存在' });
      delete config.machines[id];
      saveConfig();
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'unknown admin route' });
  }

  /* ---- 页面 ---- */

  if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) return serveStatic(res, '/admin.html');
  if (req.method === 'GET') return serveStatic(res, p);
  res.writeHead(405).end();
});

/* ================= 启动与退出 ================= */

loadConfig();
loadState();

server.listen(PORT, () => {
  console.log(`[probe] 仪表盘:    http://127.0.0.1:${PORT}/`);
  console.log(`[probe] 管理面板:  http://127.0.0.1:${PORT}/admin`);
  console.log(`[probe] 探测目标:  ${config.targets.map((t) => `${t.label}(${t.host}:${t.port})`).join(' ')}`);
  console.log(`[probe] 状态存档:  ${STATE_FILE}`);
  if (TOKEN === 'mjj-token-change-me') console.warn('[probe] ⚠ 正在使用默认 TOKEN，公网部署务必设置 TOKEN=你的密钥');
  if (ADMIN_PASSWORD === 'admin') console.warn('[probe] ⚠ 正在使用默认管理员密码，公网部署务必设置 ADMIN_PASSWORD=你的密码');
});

const saveTimer = setInterval(saveState, SAVE_INTERVAL_MS);

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n[probe] 收到 ${sig}，保存状态后退出`);
  clearInterval(saveTimer);
  saveState();
  saveConfig();
  for (const res of sseClients) { try { res.end(); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
