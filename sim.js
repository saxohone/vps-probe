#!/usr/bin/env node
/**
 * 模拟器：伪造 3 台 VPS 向探针面板上报，用于本地联调
 *   node sim.js   （需先启动 server.js）
 *
 * us-03 会在 7 个周期后停止上报，用来验证仪表盘的 OFFLINE 检测
 */
'use strict';
const http = require('http');

const SERVER = process.env.SERVER || 'http://127.0.0.1:8790';
const TOKEN = process.env.TOKEN || 'mjj-token-change-me';
const INTERVAL_MS = 3000;
const US_DIES_AFTER_TICKS = 7;

const CFG = [
  { id: 'hk-01', name: '🇭🇰 HK-CN2 轻量',  os: 'Debian 12',      kernel: '6.1.0-18-amd64',        virt: 'kvm',     cpuModel: 'AMD EPYC 9654 24-Core', cpuCount: 2, memGB: 2,  diskGB: 40,  pingBase: 35,  netMbps: 12,  unstable: false },
  { id: 'jp-02', name: '🇯🇵 JP-软银',       os: 'Ubuntu 24.04',   kernel: '6.8.0-40-generic',      virt: 'kvm',     cpuModel: 'Xeon Platinum 8375C',   cpuCount: 4, memGB: 8,  diskGB: 160, pingBase: 92,  netMbps: 45,  unstable: false },
  { id: 'us-03', name: '🇺🇸 US-9929 中转', os: 'CentOS 7.9',     kernel: '3.10.0-1160.el7.x86_64', virt: 'openvz', cpuModel: 'i9-13900K',             cpuCount: 8, memGB: 16, diskGB: 500, pingBase: 178, netMbps: 200, unstable: true },
];

const machines = CFG.map((cfg, i) => ({
  cfg,
  phase: i * 2.1,
  cpuTotal: 500000 + Math.floor(Math.random() * 90000),
  cpuIdle: 0,
  rx: Math.floor(Math.random() * 8e9),
  tx: Math.floor(Math.random() * 3e9),
  bootAt: Date.now() - Math.floor(3 + Math.random() * 60) * 86400e3,
  memTotal: cfg.memGB * 1073741824,
  diskUsed: Math.floor(cfg.diskGB * 1073741824 * (0.3 + Math.random() * 0.4)),
  diskTotal: cfg.diskGB * 1073741824,
  dead: false,
}));

function report(m, tick) {
  const { cfg } = m;
  const dt = INTERVAL_MS / 1000;

  // CPU：利用率按正弦+噪声波动，换算成 jiffies 增量
  let util = 0.3 + 0.28 * Math.sin(tick / 3 + m.phase) + (Math.random() - 0.5) * 0.12;
  util = Math.max(0.03, Math.min(0.95, util));
  const dTotal = cfg.cpuCount * 100 * dt;              // USER_HZ=100
  const dIdle = dTotal * (1 - util);
  m.cpuTotal += dTotal;
  m.cpuIdle += dIdle;

  // 网络：基础速率 + 波动 + 偶发尖峰，累计计数器持续增长
  let inMbps = cfg.netMbps * (0.5 + 0.5 * Math.abs(Math.sin(tick / 4 + m.phase)));
  let outMbps = cfg.netMbps * (0.2 + 0.3 * Math.abs(Math.cos(tick / 5 + m.phase)));
  if (Math.random() < 0.08) inMbps *= 4 + Math.random() * 6;   // 突发流量
  m.rx += inMbps / 8 * 1e6 * dt;
  m.tx += outMbps / 8 * 1e6 * dt;

  // 延迟：基础值波动，不稳定的机器偶尔超时
  let ping = cfg.pingBase * (1 + 0.12 * Math.sin(tick / 2 + m.phase) + (Math.random() - 0.4) * 0.1);
  if (cfg.unstable && Math.random() < 0.15) ping = -1;

  const memUsed = Math.floor(m.memTotal * (0.42 + 0.18 * Math.sin(tick / 6 + m.phase) + (Math.random() - 0.5) * 0.05));
  const uptime = Math.floor((Date.now() - m.bootAt) / 1000);

  const body = JSON.stringify({
    id: cfg.id, name: cfg.name, os: cfg.os, kernel: cfg.kernel, virt: cfg.virt,
    cpuModel: cfg.cpuModel, cpuCount: cfg.cpuCount,
    cpuIdle: Math.floor(m.cpuIdle), cpuTotal: Math.floor(m.cpuTotal),
    memUsed, memTotal: m.memTotal,
    diskUsed: m.diskUsed, diskTotal: m.diskTotal,
    rxBytes: Math.floor(m.rx), txBytes: Math.floor(m.tx),
    load1: (util * cfg.cpuCount + Math.random() * 0.2).toFixed(2),
    uptime, ping: ping.toFixed(1),
    tcpConns: Math.floor(30 + Math.random() * (cfg.netMbps * 4)),
  });

  const req = http.request(SERVER + '/api/report', {
    method: 'POST',
    headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => res.resume());
  req.on('error', () => {});
  req.end(body);

  console.log(`[sim] ${cfg.id} cpu=${Math.round(util * 100)}% in=${inMbps.toFixed(1)}Mbps out=${outMbps.toFixed(1)}Mbps ping=${ping < 0 ? 'timeout' : ping.toFixed(0) + 'ms'}`);
}

let tick = 0;
const timer = setInterval(() => {
  tick++;
  for (const m of machines) {
    if (m.cfg.id === 'us-03' && tick > US_DIES_AFTER_TICKS) {
      if (!m.dead) { m.dead = true; console.log(`[sim] us-03 停止上报（${US_DIES_AFTER_TICKS * INTERVAL_MS / 1000}s 后仪表盘应显示 OFFLINE）`); }
      continue;
    }
    report(m, tick);
  }
}, INTERVAL_MS);

for (const m of machines) report(m, 0);   // 立即打一波
console.log(`[sim] 模拟 ${CFG.length} 台机器 -> ${SERVER}，每 ${INTERVAL_MS / 1000}s 一轮`);
