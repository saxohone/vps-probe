# 📡 VPS 探针 (vps-probe)

自托管的多机实时监控面板。**服务端零依赖**（纯 Node，无需 `npm install`，没有 `package.json`），
**Agent 零依赖**（纯 bash + curl），扔上去就能跑。

```
┌──────────┐  POST /api/report (5s)   ┌───────────────┐  SSE /api/stream (2s)  ┌───────────┐
│  Agent   │ ───────────────────────▶ │  server.js    │ ─────────────────────▶ │  仪表盘    │
│ agent.sh │  GET  /api/targets       │ 差分·聚合·广播 │                        │ index.html │
└──────────┘ ◀─────────────────────── └───────────────┘ ◀───────────────────── └───────────┘
              探测目标由服务端下发            ▲                  管理面板改配置
                                        config.json            admin.html
```

## 功能

**监控**

- SSE 实时推送，浏览器零轮询，断线自动重连
- CPU / 内存发光环形图，上下行面积波形图（最近 60 个采样点）
- 全局统计条：在线数、实时上下行速率、累计总流量、TCP 总连接
- 每台机器显示可用率（按上报间隔累计在线时长）、负载、磁盘、TCP 连接数、运行时长、累计流量
- 15 秒未上报自动灰化卡片 + 斜置 OFFLINE 徽标 + 「最后在线 x 分前」
- 按机器名 / ID / 系统 / CPU 型号 / 国家搜索（中文国家名也能搜），可按 CPU、内存、流量、延迟排序

**TCPing 延迟监控**

- 用 **TCPing**（TCP 握手耗时）而不是 ICMP ping。原因是很多机房和三无小鸡直接封 ICMP，
  ping 不通不代表线路差；TCP 握手走的是真实业务路径，测出来才是你实际用得到的延迟
- 探测目标完全自定义：任意 IP 或域名 + 任意端口，最多 6 个，在管理面板里改
- 每个目标一条独立迷你折线图，超时点在图上标红叉、折线断开不连，统计近 60 采样的丢包次数
- 目标由服务端下发，Agent 每 5 分钟自动拉取。改一次配置全部小鸡跟着变，不用逐台重启

**国旗与国家**

- Agent 启动时自动探测所在国家（依次试 ipinfo.io / api.country.is / ifconfig.co）
- 国旗不维护映射表，直接由两位国家码算 Unicode 区域指示符码位得出（`HK` → 🇭🇰），全球覆盖
- 探测失败或探错了，在管理面板手动指定，覆盖值会持久化

**管理面板** `/admin`

- 探测目标增删改（名称 / 主机 / 端口 / 图表颜色）
- 机器改显示名、改国家、删除废弃机器
- 一键生成带服务端地址和 TOKEN 的安装命令，可直接复制

**持久化与安全**

- 运行状态每 30 秒落盘 `state.json`，配置改动即时写 `config.json`，重启后曲线和可用率不丢
- Agent 上报需 `X-Token` 请求头；管理面板密码用 `timingSafeEqual` 比对，
  会话是 32 字节随机 + HttpOnly + SameSite=Strict cookie，8 小时过期，同 IP 连续失败 8 次锁 10 分钟
- 探测目标做了 SSRF 防护：拒绝环回、10/172.16/192.168 私网、169.254 链路本地（云元数据就在这段）、
  100.64 CGNAT、组播保留段、IPv6 环回/链路本地/唯一本地，以及 `localhost` / `.internal` 这类本机别名

## 部署服务端

任意一台有公网 IP 的机器（NAS、家宽小鸡都行）：

```bash
git clone https://github.com/saxohone/vps-probe && cd vps-probe
TOKEN=换成你自己的密钥 ADMIN_PASSWORD=换成你自己的密码 node server.js
```

打开 `http://你的IP:8790/` 是仪表盘，`/admin` 是管理面板。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8790` | 监听端口 |
| `TOKEN` | `mjj-token-change-me` | Agent 上报密钥，**务必改掉** |
| `ADMIN_PASSWORD` | `admin` | 管理面板密码，**务必改掉** |
| `PUBLIC_URL` | 空 | 对外地址，如 `https://probe.example.com`。反代时设上，生成的安装命令才是对的 |
| `ALLOWED_ORIGINS` | 空 | 只读接口的跨域白名单，逗号分隔。留空则仅同源，不放行跨域 |
| `STATE_FILE` | `./state.json` | 运行状态存档路径 |
| `CONFIG_FILE` | `./config.json` | 探测目标与机器备注存档路径 |

默认 TOKEN 或默认密码会在启动时打黄色警告，管理面板顶部也会挂红条提醒。

### systemd 常驻

```ini
# /etc/systemd/system/probe.service
[Unit]
Description=VPS Probe Server
After=network.target

[Service]
WorkingDirectory=/opt/vps-probe
ExecStart=/usr/bin/node /opt/vps-probe/server.js
Environment=TOKEN=你的密钥
Environment=ADMIN_PASSWORD=你的密码
Environment=PORT=8790
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now probe
```

`WorkingDirectory` 要设对，两个存档文件默认写在脚本同目录。收到 SIGTERM 会先落盘再退出，
所以 `systemctl restart` 不会丢历史。

### nginx 反代

SSE 必须关缓冲，否则数据会被攒住不实时（服务端已发 `X-Accel-Buffering: no`，新版 nginx 会遵守）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

反代后记得设 `PUBLIC_URL=https://你的域名`，不然管理面板生成的安装命令会指向内网地址。

## 部署 Agent

最省事的办法：在管理面板「🚀 生成安装命令」里填好名字和国家，点生成，复制粘贴到小鸡上执行。

手动也一样：

```bash
curl -sL https://你的域名/agent.sh -o agent.sh
chmod +x agent.sh

# 先自检一次，确认这台机器上 TCPing 工作正常
./agent.sh --selftest

# 前台试跑，确认面板出现卡片
./agent.sh https://你的域名 你的TOKEN "HK-CN2" HK

# 挂后台
nohup ./agent.sh https://你的域名 你的TOKEN "HK-CN2" HK >/dev/null 2>&1 &
```

参数：

| 位置 | 说明 |
|---|---|
| `$1` | 服务端地址 |
| `$2` | TOKEN（与服务端一致） |
| `$3` | 显示名（可选，省略用 hostname） |
| `$4` | 国家码（可选，省略则自动探测） |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `INTERVAL` | `5` | 上报间隔（秒） |
| `TCP_TIMEOUT` | `2` | 单次 TCPing 超时（秒） |
| `TARGET_TTL` | `300` | 探测目标缓存时间（秒） |
| `NO_GEO` | `0` | 设为 1 禁用国家自动探测 |

### 关于 `--selftest`

TCPing 用 bash 内建 `/dev/tcp`，真实 Linux 上可靠，但某些模拟环境（Windows Git Bash / MSYS）
会把根本连不通的地址也报成连接成功。`--selftest` 会同时测三个「应该通」和三个「应该不通」的目标，
把不可达判成连通就报错退出。装完 Agent 先跑一次，别等数据错了才发现。

Agent 只读 `/proc`、`df`、`ping`、`ss`，不需要 root，OpenVZ 也能跑。
多个目标并行 TCPing，单轮耗时约等于一次超时而不是 N 倍。
CPU 与网速的差分计算全在服务端做，每次上报只是 ~600 字节 JSON。

### systemd 常驻 Agent

```ini
# /etc/systemd/system/probe-agent.service
[Unit]
Description=VPS Probe Agent
After=network.target

[Service]
ExecStart=/opt/vps-probe/agent.sh https://你的域名 你的TOKEN "HK-CN2" HK
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## 本地体验（不用 VPS）

模拟器伪造 3 台机器（香港 / 日本 / 美国），美国那台约 21 秒后停止上报，可以看 OFFLINE 徽标出现：

```bash
ADMIN_PASSWORD=test1234 node server.js   # 终端 1
node sim.js                              # 终端 2
# 仪表盘 http://127.0.0.1:8790/
# 管理端 http://127.0.0.1:8790/admin  （密码 test1234）
```

`SEED=42 node sim.js` 固定随机种子可复现同一组数据。模拟器会从 `/api/targets` 动态拉目标，
所以在管理面板加个新目标，模拟器也会跟着测，方便验证。
`sim.js` 只允许指向回环地址，避免被误当成压测工具打到外网。

## API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | — | 仪表盘 |
| GET | `/admin` | — | 管理面板（页面内登录） |
| GET | `/agent.sh` | — | Agent 脚本，供 VPS curl 安装 |
| GET | `/api/data` | — | 当前全量快照（JSON） |
| GET | `/api/stream` | — | SSE 实时推送（2s/帧） |
| POST | `/api/report` | `X-Token` | Agent 上报 |
| GET | `/api/targets` | `X-Token` | 探测目标列表（TSV，便于 bash 解析） |
| POST | `/api/admin/login` `/logout` | 密码 | 管理登录，成功下发会话 cookie |
| GET | `/api/admin/config` | 会话 | 读取目标、机器、国家表、安装命令 |
| POST | `/api/admin/target/save` `/delete` | 会话 | 探测目标增删改 |
| POST | `/api/admin/machine/save` `/delete` | 会话 | 机器备注与删除 |
| POST | `/api/admin/install` | 会话 | 生成安装命令 |

## 目录结构

```
vps-probe/
├── server.js            # 服务端：聚合 + SSE 广播 + 管理 API + 持久化 + 静态托管
├── agent.sh             # Agent：bash + curl，读 /proc 采集，TCPing 测延迟
├── sim.js               # 本地模拟器（联调用）
├── public/
│   ├── index.html       # 仪表盘（暗色主题，canvas 图表，零框架）
│   └── admin.html       # 管理面板（零框架）
├── state.json           # 运行时自动生成，已 gitignore
└── config.json          # 运行时自动生成，已 gitignore
```

## 关于 Cloudflare Workers

问过能不能跑在 CF 上，答案是这套架构不行，原因有两条：

1. Workers 运行时不给原始 TCP socket，做不了 TCPing。虽然现在 TCPing 是 Agent 自己做的，
   但服务端也就失去了独立验证能力
2. Workers 是无状态的。SSE 长连接、60 点历史数组、可用率累计全靠常驻进程的内存，
   搬到 CF 得全改成 Durable Objects + KV，等于重写一套

真要上 CF 只能做成「Workers 收上报写 KV + 前端轮询」，实时性和成本都不如一个几十块的小鸡跑 Node。
所以现在是纯 Node 版，任何能跑 Node 的机器都行，包括 ARM 和 OpenVZ。

## License

MIT
