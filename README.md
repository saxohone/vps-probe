# 📡 VPS 探针 (vps-probe)

自托管的多机实时监控面板——哪吒监控的极氪版：**服务端零依赖**（纯 Node，无需 npm install），
Agent 零依赖（纯 bash + curl），单文件扔上去就能跑。

```
┌──────────┐  HTTP POST /api/report   ┌───────────────┐  SSE /api/stream   ┌──────────┐
│  Agent   │ ───────────────────────▶ │  server.js    │ ─────────────────▶ │ 仪表盘    │
│ agent.sh │      5s / 次             │  差分/聚合/广播│      2s / 帧       │ index.html│
└──────────┘                          └───────────────┘                    └──────────┘
```

## 功能

- **实时刷新**：SSE 推流，浏览器无轮询，断线自动重连
- **全局统计条**：在线数、实时上/下行速率、累计总流量、TCP 总连接
- **CPU / 内存发光环形图**、**上下行网络波形图**（canvas，最近 60 个采样点）
- **延迟监控**：每台机器一条延迟历史图（超时在图上标红叉），
  当前值按 <80 绿 / <180 黄 / 其余红 分级徽标
- **总流量**：头部累计总和 + 每台机器开机以来累计上下行（读 `/proc/net/dev` 差分，排除 lo）
- **离线检测**：15s 未上报自动打 OFFLINE 徽标、卡片置灰去色
- **响应式**：>1140px 三列 / 窄屏两列一列自适应
- **安全**：Agent 上报需 `X-Token` 请求头，错误 token 返回 401

## 服务端

任意一台有公网 IP 的机器（也可以是你的 NAS / 家里闲置 VPS）：

```bash
TOKEN=你自己的密钥 PORT=8790 node server.js
```

就这一个文件，没了。开机自启建议用 systemd：

```ini
# /etc/systemd/system/probe.service
[Unit]
Description=VPS Probe Server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/vps-probe/server.js
Environment=TOKEN=你自己的密钥
Environment=PORT=8790
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now probe
```

### nginx 反代（可选）

SSE 需要 `proxy_buffering off`（服务端已发 `X-Accel-Buffering: no`，新版 nginx 会自动遵守）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## Agent（在每台被监控的 VPS 上）

```bash
# 前台试跑
./agent.sh http://服务端IP:8790 你的TOKEN "🇭🇰 HK-CN2"

# 确认面板有数据后，挂后台
nohup ./agent.sh http://服务端IP:8790 你的TOKEN "🇭🇰 HK-CN2" >/dev/null 2>&1 &
```

参数：

| 位置 | 说明 |
|---|---|
| $1 | 服务端地址 |
| $2 | TOKEN（与服务端一致） |
| $3 | 显示名（支持 emoji 国旗） |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `INTERVAL` | 5 | 上报间隔（秒） |
| `PING_TARGET` | 223.5.5.5 | 延迟探测目标（测美西就换 1.1.1.1） |

Agent 全程只读 `/proc` 和 `df`/`ping`/`ss`，CPU 与网速的差分计算在服务端完成，
每次上报只是一个 ~500 字节的 JSON。需要 systemd 常驻的话把上面 nohup 换成
`ExecStart=/opt/vps-probe/agent.sh http://... TOKEN 名字` 即可。

## 本地体验

不用 VPS 也能玩，模拟器会伪造 3 台机器（香港/日本/美国），美国那台 21s 后
停止上报，可以观察 OFFLINE 徽标出现：

```bash
node server.js     # 终端 1
node sim.js        # 终端 2
# 浏览器打开 http://127.0.0.1:8790/
```

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
├── server.js        # 服务端：聚合 + SSE 广播 + 静态托管
├── agent.sh         # Agent：bash + curl，读 /proc 采集
├── sim.js           # 本地模拟器（联调用）
└── public/
    └── index.html   # 仪表盘（暗色主题，canvas 波形）
```
