# 📡 VPS 探针 (vps-probe)

自托管的多机实时监控面板——**服务端零依赖**（纯 Node，无需 `npm install`），
**Agent 零依赖**（纯 bash + curl），扔上去就能跑。

```
┌──────────┐  HTTP POST /api/report   ┌───────────────┐  SSE /api/stream   ┌───────────┐
│  Agent   │ ───────────────────────▶ │  server.js    │ ─────────────────▶ │  仪表盘    │
│ agent.sh │      5s / 次             │ 差分·聚合·广播 │      2s / 帧       │ index.html │
└──────────┘                          └───────────────┘                    └───────────┘
```

## 功能

- **实时推送**：SSE 推流，浏览器零轮询，断线自动重连
- **三网延迟监控**：Agent 并行 ping 电信/联通/移动三个方向，
  每条线路独立迷你折线图，超时点在图上标红叉，统计近 60 采样的丢包次数
- **可用率**：按上报间隔累计在线时长，每台机器显示 `可用 99.87%`（≥99.5 绿 / ≥95 黄 / 其余红）
- **全局统计条**：在线数、实时上下行速率、累计总流量、TCP 总连接
- **CPU / 内存发光环形图**、**上下行面积波形图**（最近 60 个采样点）
- **搜索与排序**：按机器名/ID/系统/CPU 型号搜索，可按 CPU、内存、流量、延迟排序
- **离线检测**：15s 未上报自动灰化卡片 + 斜置 OFFLINE 徽标 + 「最后在线 x 分前」
- **状态持久化**：每 30s 落盘 `state.json`，服务端重启后历史曲线和可用率不丢
- **响应式**：宽屏三列，窄屏自动降到两列/一列
- **鉴权**：Agent 上报需 `X-Token` 请求头，错误 token 返回 401

## 服务端

任意一台有公网 IP 的机器（NAS、家宽小鸡都行）：

```bash
git clone https://github.com/saxohone/vps-probe && cd vps-probe
TOKEN=换成你自己的密钥 PORT=8790 node server.js
```

就一个文件，没有 `package.json`，没有依赖。开机自启用 systemd：

```ini
# /etc/systemd/system/probe.service
[Unit]
Description=VPS Probe Server
After=network.target

[Service]
WorkingDirectory=/opt/vps-probe
ExecStart=/usr/bin/node /opt/vps-probe/server.js
Environment=TOKEN=换成你自己的密钥
Environment=PORT=8790
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now probe
```

> `WorkingDirectory` 要设对，`state.json` 默认写在脚本同目录；也可以用 `STATE_FILE=/var/lib/probe/state.json` 指定。

### nginx 反代（可选）

SSE 必须关闭缓冲，否则数据会被攒住不实时（服务端已发 `X-Accel-Buffering: no`）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## Agent（每台被监控的 VPS）

```bash
curl -sL https://raw.githubusercontent.com/saxohone/vps-probe/main/agent.sh -o agent.sh
chmod +x agent.sh

# 前台试跑，确认面板出现卡片
./agent.sh http://服务端IP:8790 你的TOKEN "🇭🇰 HK-CN2"

# 挂后台
nohup ./agent.sh http://服务端IP:8790 你的TOKEN "🇭🇰 HK-CN2" >/dev/null 2>&1 &
```

参数：

| 位置 | 说明 |
|---|---|
| `$1` | 服务端地址 |
| `$2` | TOKEN（与服务端一致） |
| `$3` | 显示名（支持 emoji 国旗，省略则用 hostname） |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `INTERVAL` | `5` | 上报间隔（秒） |
| `PING_CT` | `219.141.136.12` | 电信探测目标（北京电信） |
| `PING_CU` | `202.106.50.1` | 联通探测目标（北京联通） |
| `PING_CM` | `221.179.155.161` | 移动探测目标（北京移动） |

Agent 只读 `/proc`、`df`、`ping`、`ss`，不需要特权，OpenVZ 也能跑。
三个 ping 并行执行，单轮耗时约等于一次超时而不是三倍。
CPU 与网速的差分计算全在服务端做，每次上报只是 ~500 字节 JSON。

## 本地体验（不用 VPS）

模拟器伪造 3 台机器（香港/日本/美国），美国那台约 21s 后停止上报，可以看 OFFLINE 徽标出现：

```bash
node server.js     # 终端 1
node sim.js        # 终端 2
# 浏览器打开 http://127.0.0.1:8790/
```

`SEED=42 node sim.js` 可固定随机种子复现同一组数据。
`sim.js` 只允许指向回环地址，避免误当成压测工具打到外网。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/report` | Agent 上报，需 `X-Token` 头 |
| GET | `/api/data` | 当前全量快照（JSON） |
| GET | `/api/stream` | SSE 实时推送（2s/帧） |
| GET | `/` | 仪表盘 |

## 目录结构

```
vps-probe/
├── server.js          # 服务端：聚合 + SSE 广播 + 持久化 + 静态托管
├── agent.sh           # Agent：bash + curl，读 /proc 采集
├── sim.js             # 本地模拟器（联调用）
├── public/index.html  # 仪表盘（暗色主题，canvas 图表，零框架）
└── state.json         # 运行时自动生成，已在 .gitignore
```

## License

MIT
