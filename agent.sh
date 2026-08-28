#!/usr/bin/env bash
#
# VPS 探针 Agent —— 纯 bash + curl，零依赖
#
# 用法:
#   ./agent.sh <服务端地址> <TOKEN> [机器显示名]
#   例: ./agent.sh http://1.2.3.4:8790 my-secret-token "🇭🇰 HK-轻量"
#
# 环境变量:
#   INTERVAL=5          上报间隔（秒）
#   PING_TARGET=223.5.5.5  延迟探测目标，默认阿里 DNS（衡量到大陆方向线路质量）
#
# 一键部署（在 VPS 上）:
#   curl -sL https://你的地址/agent.sh -o agent.sh && chmod +x agent.sh
#   nohup ./agent.sh http://服务端:8790 TOKEN "名字" >/dev/null 2>&1 &
#
set -u

SERVER="${1:?用法: ./agent.sh <服务端地址> <TOKEN> [机器显示名]}"
TOKEN="${2:?缺少 TOKEN，第二个参数填服务端的 TOKEN}"
NAME="${3:-$(hostname)}"
INTERVAL="${INTERVAL:-5}"
PING_TARGET="${PING_TARGET:-223.5.5.5}"
HOST_ID="$(hostname)"

# ---------- 静态信息只采集一次 ----------
read_os() {
  . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-$NAME}" || uname -sr
}
OS="$(read_os)"
KERNEL="$(uname -r)"
VIRT="$(systemd-detect-virt 2>/dev/null || echo unknown)"
CPU_MODEL="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
[ -z "$CPU_MODEL" ] && CPU_MODEL="$(uname -m)"
CPU_COUNT="$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)"

echo "[agent] id=$HOST_ID name=$NAME"
echo "[agent] OS=$OS virt=$VIRT cpu=${CPU_COUNT}x target=$PING_TARGET every=${INTERVAL}s"

# ---------- 采集函数（全部输出累计值，差分计算在服务端完成）----------

# CPU 累计 jiffies: "idle total"
read_cpu() {
  set -- $(head -1 /proc/stat)
  local idle=$(( $5 + $6 )) total=0 i
  for (( i = 1; i <= 10; i++ )); do total=$(( total + ${!i:-0} )); done
  echo "$idle $total"
}

# 网络累计字节数（排除 lo）: "rx tx"
read_net() {
  awk -F'[: ]+' 'NR>2 && $2!="lo" { rx+=$3; tx+=$11 } END { print rx+0, tx+0 }' /proc/net/dev
}

# 内存: "used total"（字节）
read_mem() {
  local total avail
  total=$(awk '/^MemTotal/    {print $2}' /proc/meminfo)
  avail=$(awk '/^MemAvailable/{print $2}' /proc/meminfo)
  [ -z "$avail" ] && avail=$(awk '/^MemFree/{print $2}' /proc/meminfo)
  echo $(( (total - avail) * 1024 )) $(( total * 1024 ))
}

# 磁盘 / : "used total"（字节）
read_disk() {
  df -k / 2>/dev/null | awk 'NR==2 { printf "%d %d\n", $3*1024, $2*1024 }'
}

# 到大陆目标延迟 ms，失败输出 -1
read_ping() {
  local t
  t=$(ping -c1 -W2 "$PING_TARGET" 2>/dev/null | awk -F'time=' '/time=/ {split($2,a," "); print a[1]; exit}')
  echo "${t:--1}"
}

# TCP 连接数
read_tcp() {
  if command -v ss >/dev/null 2>&1; then
    ss -t state established 2>/dev/null | tail -n +2 | wc -l
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tn 2>/dev/null | grep -c ESTABLISHED
  else
    echo 0
  fi
}

# ---------- 主循环 ----------
while :; do
  read -r CPU_IDLE CPU_TOTAL <<< "$(read_cpu)"
  read -r RX TX               <<< "$(read_net)"
  read -r MEM_USED MEM_TOTAL  <<< "$(read_mem)"
  read -r DISK_USED DISK_TOTAL<<< "$(read_disk)"
  PING=$(read_ping)
  LOAD1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
  UPTIME=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || echo 0)
  TCP=$(read_tcp)

  JSON=$(printf \
    '{"id":"%s","name":"%s","os":"%s","kernel":"%s","virt":"%s","cpuModel":"%s","cpuCount":%d,"cpuIdle":%s,"cpuTotal":%s,"memUsed":%s,"memTotal":%s,"diskUsed":%s,"diskTotal":%s,"rxBytes":%s,"txBytes":%s,"load1":%s,"uptime":%s,"ping":%s,"tcpConns":%s}' \
    "$HOST_ID" "$NAME" "$OS" "$KERNEL" "$VIRT" "$CPU_MODEL" "$CPU_COUNT" \
    "$CPU_IDLE" "$CPU_TOTAL" "$MEM_USED" "$MEM_TOTAL" "$DISK_USED" "$DISK_TOTAL" \
    "$RX" "$TX" "$LOAD1" "$UPTIME" "$PING" "$TCP")

  if ! curl -sS -m 5 -X POST "$SERVER/api/report" \
       -H "X-Token: $TOKEN" -H 'Content-Type: application/json' \
       -d "$JSON" > /dev/null 2>&1; then
    echo "[agent] $(date '+%H:%M:%S') 上报失败，重试中..."
  fi
  sleep "$INTERVAL"
done
