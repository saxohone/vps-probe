#!/usr/bin/env node
/**
 * 模拟器：伪造 3 台 VPS 向探针面板上报，用于本地联调
 *   node sim.js                          （需先启动 server.js）
 *   SEED=42 node sim.js                   固定种子，可复现同一组数据
 *   SERVER=http://127.0.0.1:8790 node sim.js
 *
 * us-03 会在 7 个周期后停止上报，用来验证仪表盘的 OFFLINE 检测
 *
 * 说明:
 *  - 随机数只用于生成假监控指标，不涉及加密用途，故用可复现的 mulberry32 PRNG。
 *  - 上报目标在启动时一次性解析并校验（仅 http、仅本机回环地址），路径是代码里的字面量，
 *    不接受外部输入拼接。
 *  - 探测目标从服务端 /api/targets 动态拉取，管理面板里增删目标这边会跟着变。
 */
'use strict';
const http = require('http');

const INTERVAL_MS = 3000;
const US_DIES_AFTER_TICKS = 7;
const TOKEN = process.env.TOKEN || 'mjj-token-change-me';
const TARGET_REFRESH_TICKS = 4;   // 每 4 轮重新拉一次目标列表

/* ---------- 上报目标：启动时校验一次，只允许本机回环 ---------- */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const HOSTNAME = (function parseHost(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error(`SERVER 不是合法 URL: ${raw}`); }
  if (u.protocol !== 'http:') throw new Error(`SERVER 只支持 http:，收到 ${u.protocol}`);
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`sim.js 是本地联调工具，SERVER 只能指向回环地址，收到 ${u.hostname}`);
  }
  return u.hostname;
})(process.env.SERVER || 'http://127.0.0.1:8790');
const PORT = (function parsePort(raw) {
  const n = Number(new URL(raw).port) || 80;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('SERVER 端口非法');
  return n;
})(process.env.SERVER || 'http://127.0.0.1:8790');

/* ---------- 可复现伪随机（mulberry32），非加密用途 ---------- */
const SEED_IN = Number(process.env.SEED) || 20260829;
let _seed = SEED_IN >>> 0;
function rnd() {
  _seed = (_seed + 0x6d2b79f5) >>> 0;
  let t = _seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const CFG = [
  { id: 'hk-01', name: 'HK-CN2 轻量',  country: 'HK', os: 'Debian 12',    kernel: '6.1.0-18-amd64',         virt: 'kvm',    cpuModel: 'AMD EPYC 9654 24-Core', cpuCount: 2, memGB: 2,  diskGB: 40,  pingBase: 35,  netMbps: 12,  unstable: false },
  { id: 'jp-02', name: 'JP-软银',      country: 'JP', os: 'Ubuntu 24.04', kernel: '6.8.0-40-generic',       virt: 'kvm',    cpuModel: 'Xeon Platinum 8375C',   cpuCount: 4, memGB: 8,  diskGB: 160, pingBase: 92,  netMbps: 45,  unstable: false },
  { id: 'us-03', name: 'US-9929 中转', country: 'US', os: 'CentOS 7.9',   kernel: '3.10.0-1160.el7.x86_64', virt: 'openvz', cpuModel: 'i9-13900K',             cpuCount: 8, memGB: 16, diskGB: 500, pingBase: 178, netMbps: 200, unstable: true },
];

const machines = CFG.map((cfg, i) => ({
  cfg,
  phase: i * 2.1,
  cpuTotal: 500000 + Math.floor(rnd() * 90000),
  cpuIdle: 0,
  rx: Math.floor(rnd() * 8e9),
  tx: Math.floor(rnd() * 3e9),
  bootAt: Date.now() - Math.floor(3 + rnd() * 60) * 86400e3,
  memTotal: cfg.memGB * 1073741824,
  diskUsed: Math.floor(cfg.diskGB * 1073741824 * (0.3 + rnd() * 0.4)),
  diskTotal: cfg.diskGB * 1073741824,
  dead: false,
}));

// 服务端下发的探测目标（id + 相对延迟倍率），拉不到时先按默认三网跑
let targets = [
  { id: 'ct', mult: 1.0, lossRate: 0.12 },
  { id: 'cu', mult: 1.18, lossRate: 0.15 },
  { id: 'cm', mult: 1.45, lossRate: 0.22 },
];

// 拉取探测目标：路径是字面量 '/api/targets'，主机固定为已校验的回环地址
function fetchTargets() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: HOSTNAME,
      port: PORT,
      path: '/api/targets',
      method: 'GET',
      headers: { 'X-Token': TOKEN },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve(res.statusCode === 200 ? buf : ''));
    });
    req.on('error', () => resolve(''));
    req.end();
  });
}

// 上报指标：路径是字面量 '/api/report'
function postReport(body) {
  const req = http.request({
    hostname: HOSTNAME,
    port: PORT,
    path: '/api/report',
    method: 'POST',
    headers: {
      'X-Token': TOKEN,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => res.resume());
  req.on('error', () => {});
  req.end(body);
}

async function refreshTargets() {
  const tsv = await fetchTargets();
  if (!tsv.trim()) return;
  const list = tsv.trim().split('\n').map((line, i) => {
    const id = line.split('\t')[0];
    return { id, mult: 1 + i * 0.18, lossRate: 0.12 + i * 0.04 };
  }).filter((t) => t.id);
  if (!list.length) return;
  const changed = list.length !== targets.length || list.some((t, i) => t.id !== targets[i].id);
  targets = list;
  if (changed) console.log(`[sim] 探测目标已更新: ${list.map((t) => t.id).join(', ')}`);
}

function report(m, tick) {
  const { cfg } = m;
  const dt = INTERVAL_MS / 1000;

  // CPU：利用率按正弦+噪声波动，换算成 jiffies 增量
  let util = 0.3 + 0.28 * Math.sin(tick / 3 + m.phase) + (rnd() - 0.5) * 0.12;
  util = Math.max(0.03, Math.min(0.95, util));
  const dTotal = cfg.cpuCount * 100 * dt;              // USER_HZ=100
  m.cpuTotal += dTotal;
  m.cpuIdle += dTotal * (1 - util);

  // 网络：基础速率 + 波动 + 偶发尖峰，累计计数器持续增长
  let inMbps = cfg.netMbps * (0.5 + 0.5 * Math.abs(Math.sin(tick / 4 + m.phase)));
  const outMbps = cfg.netMbps * (0.2 + 0.3 * Math.abs(Math.cos(tick / 5 + m.phase)));
  if (rnd() < 0.08) inMbps *= 4 + rnd() * 6;           // 突发流量
  m.rx += inMbps / 8 * 1e6 * dt;
  m.tx += outMbps / 8 * 1e6 * dt;

  // 按服务端下发的目标逐个造延迟；不稳定的机器按各自概率超时
  const pings = {};
  const parts = [];
  for (const t of targets) {
    let v;
    if (cfg.unstable && rnd() < t.lossRate) v = -1;
    else v = cfg.pingBase * t.mult * (1 + 0.12 * Math.sin(tick / 2 + m.phase) + (rnd() - 0.4) * 0.1);
    pings[t.id] = Number(v.toFixed(1));
    parts.push(`${t.id}=${v < 0 ? 'timeout' : v.toFixed(0) + 'ms'}`);
  }

  const memUsed = Math.floor(m.memTotal * (0.42 + 0.18 * Math.sin(tick / 6 + m.phase) + (rnd() - 0.5) * 0.05));
  const uptime = Math.floor((Date.now() - m.bootAt) / 1000);

  postReport(JSON.stringify({
    id: cfg.id, name: cfg.name, country: cfg.country,
    os: cfg.os, kernel: cfg.kernel, virt: cfg.virt,
    cpuModel: cfg.cpuModel, cpuCount: cfg.cpuCount,
    cpuIdle: Math.floor(m.cpuIdle), cpuTotal: Math.floor(m.cpuTotal),
    memUsed, memTotal: m.memTotal,
    diskUsed: m.diskUsed, diskTotal: m.diskTotal,
    rxBytes: Math.floor(m.rx), txBytes: Math.floor(m.tx),
    load1: (util * cfg.cpuCount + rnd() * 0.2).toFixed(2),
    uptime,
    tcpConns: Math.floor(30 + rnd() * (cfg.netMbps * 4)),
    agentVer: 'sim',
    pings,
  }));

  console.log(`[sim] ${cfg.id} cpu=${Math.round(util * 100)}% in=${inMbps.toFixed(1)}Mbps out=${outMbps.toFixed(1)}Mbps ${parts.join(' ')}`);
}

let tick = 0;

(async function main() {
  await refreshTargets();
  for (const m of machines) report(m, 0);
  console.log(`[sim] 模拟 ${CFG.length} 台机器 -> http://${HOSTNAME}:${PORT}，每 ${INTERVAL_MS / 1000}s 一轮，seed=${SEED_IN}`);

  setInterval(async () => {
    tick++;
    if (tick % TARGET_REFRESH_TICKS === 0) await refreshTargets();
    for (const m of machines) {
      if (m.cfg.id === 'us-03' && tick > US_DIES_AFTER_TICKS) {
        if (!m.dead) { m.dead = true; console.log(`[sim] us-03 停止上报（约 ${US_DIES_AFTER_TICKS * INTERVAL_MS / 1000}s 起仪表盘应显示 OFFLINE）`); }
        continue;
      }
      report(m, tick);
    }
  }, INTERVAL_MS);
})();
