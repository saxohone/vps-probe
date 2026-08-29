#!/usr/bin/env bash
#
# VPS 探针 Agent —— 纯 bash + curl，零依赖
#
# 用法:
#   ./agent.sh <服务端地址> <TOKEN> [机器显示名]
#   例: ./agent.sh http://1.2.3.4:8790 my-secret-token "🇭🇰 HK-CN2"
#
# 环境变量:
#   INTERVAL=5     上报间隔（秒）
#   PING_CT / PING_CU / PING_CM   三网探测目标（默认北京电信/联通/移动）
#
# 一键部署（在 VPS 上）:
#   curl -sL https://raw.githubusercontent.com/<你>/vps-probe/main/agent.sh -o agent.sh
#   chmod +x agent.sh
#   nohup ./agent.sh http://服务端:8790 TOKEN "名字" >/dev/null 2>&1 &
#
set -u

SERVER="${1:?用法: ./agent.sh <服务端地址> <TOKEN> [机器显示名]}"
TOKEN="${2:?缺少 TOKEN，第二个参数填服务端的 TOKEN}"
NAME="${3:-$(hostname)}"
INTERVAL="${INTERVAL:-5}"

# 三网延迟探测目标（mjj 圈通用测试 IP，可用环境变量覆盖）
PING_CT="${PING_CT:-219.141.136.12}"   # 北京电信
PING_CU="${PING_CU:-202.106.50.1}"     # 北京联通
PING_CM="${PING_CM:-221.179.155.161}"  # 北京移动

HOST_ID="$(hostname)"

# ---------- 静态信息只采集一次 ----------
OS="$( { . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}"; } || true )"
[ -z "$OS" ] && OS="$(uname -sr)"
KERNEL="$(uname -r)"
VIRT="$(systemd-detect-virt 2>/dev/null || echo unknown)"
CPU_MODEL="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
[ -z "$CPU_MODEL" ] && CPU_MODEL="$(uname -m)"
CPU_COUNT="$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)"

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

echo "[agent] id=$HOST_ID name=$NAME"
echo "[agent] OS=$OS virt=$VIRT cpu=${CPU_COUNT}x every=${INTERVAL}s"
echo "[agent] 三网目标 电信=$PING_CT 联通=$PING_CU 移动=$PING_CM"

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

# 单目标延迟 ms，失败输出 -1
read_ping() {
  local t
  t=$(ping -c1 -W2 "$1" 2>/dev/null | awk -F'time=' '/time=/ {split($2,a," "); print a[1]; exit}')
  echo "${t:--1}"
}

# TCP 已建立连接数
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
  # 三网 ping 并行跑，总耗时 ≈ 单次超时而不是三倍
  read_ping "$PING_CT" > "$TMPD/ct" &
  read_ping "$PING_CU" > "$TMPD/cu" &
  read_ping "$PING_CM" > "$TMPD/cm" &

  read -r CPU_IDLE CPU_TOTAL  <<< "$(read_cpu)"
  read -r RX TX               <<< "$(read_net)"
  read -r MEM_USED MEM_TOTAL  <<< "$(read_mem)"
  read -r DISK_USED DISK_TOTAL<<< "$(read_disk)"
  LOAD1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
  UPTIME=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || echo 0)
  TCP=$(read_tcp)

  wait
  P_CT=$(cat "$TMPD/ct" 2>/dev/null || echo -1)
  P_CU=$(cat "$TMPD/cu" 2>/dev/null || echo -1)
  P_CM=$(cat "$TMPD/cm" 2>/dev/null || echo -1)

  JSON=$(printf \
    '{"id":"%s","name":"%s","os":"%s","kernel":"%s","virt":"%s","cpuModel":"%s","cpuCount":%d,"cpuIdle":%s,"cpuTotal":%s,"memUsed":%s,"memTotal":%s,"diskUsed":%s,"diskTotal":%s,"rxBytes":%s,"txBytes":%s,"load1":%s,"uptime":%s,"pingCt":%s,"pingCu":%s,"pingCm":%s,"tcpConns":%s}' \
    "$HOST_ID" "$NAME" "$OS" "$KERNEL" "$VIRT" "$CPU_MODEL" "$CPU_COUNT" \
    "$CPU_IDLE" "$CPU_TOTAL" "$MEM_USED" "$MEM_TOTAL" "$DISK_USED" "$DISK_TOTAL" \
    "$RX" "$TX" "$LOAD1" "$UPTIME" "$P_CT" "$P_CU" "$P_CM" "$TCP")

  if ! curl -sS -m 5 -X POST "$SERVER/api/report" \
       -H "X-Token: $TOKEN" -H 'Content-Type: application/json' \
       -d "$JSON" > /dev/null 2>&1; then
    echo "[agent] $(date '+%H:%M:%S') 上报失败，重试中..."
  fi
  sleep "$INTERVAL"
done
