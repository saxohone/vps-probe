#!/usr/bin/env bash
#
# VPS 探针 Agent —— 纯 bash + curl，零依赖，TCPing 版
#
# 用法:
#   ./agent.sh <服务端地址> <TOKEN> [显示名] [国家码]
#   例: ./agent.sh https://probe.example.com my-token "HK-CN2" HK
#
# 显示名省略则用 hostname；国家码省略则自动探测（失败则留空，可在管理面板补）。
# 探测目标由服务端下发，在管理面板里改，Agent 每 5 分钟重新拉取一次。
#
# 环境变量:
#   INTERVAL=5        上报间隔（秒）
#   TCP_TIMEOUT=2     单次 TCPing 超时（秒）
#   TARGET_TTL=300    探测目标缓存时间（秒）
#   NO_GEO=1          禁用国家自动探测
#
set -u

AGENT_VER="2.0"

SERVER="${1:-}"
TOKEN="${2:-}"

# 自检模式：./agent.sh --selftest [host port ...]
# 在真实 VPS 上先跑一次，确认 TCPing 能正确区分「通」与「不通」再挂后台。
if [ "$SERVER" = "--selftest" ]; then
  SELFTEST=1
else
  SELFTEST=0
fi

if [ "$SELFTEST" = "0" ] && { [ -z "$SERVER" ] || [ -z "$TOKEN" ]; }; then
  echo "用法: ./agent.sh <服务端地址> <TOKEN> [显示名] [国家码]"
  echo "例:   ./agent.sh https://probe.example.com my-token \"HK-CN2\" HK"
  echo "自检: ./agent.sh --selftest"
  exit 1
fi
SERVER="${SERVER%/}"
NAME="${3:-$(hostname)}"
COUNTRY="${4:-}"

INTERVAL="${INTERVAL:-5}"
TCP_TIMEOUT="${TCP_TIMEOUT:-2}"
TARGET_TTL="${TARGET_TTL:-300}"

HOST_ID="$(hostname)"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
TARGETS_FILE="$TMPD/targets.tsv"
TARGETS_AT=0

# ---------- 依赖检查 ----------
command -v curl >/dev/null 2>&1 || { echo "[agent] 缺少 curl，请先安装"; exit 1; }
# TCPing 用 bash 内建 /dev/tcp，需要真 bash 而非 dash/sh
if [ -z "${BASH_VERSION:-}" ]; then
  echo "[agent] 需要用 bash 运行（不是 sh）: bash agent.sh ..."
  exit 1
fi

# ---------- 静态信息只采集一次 ----------
OS="$( { . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}"; } || true )"
[ -z "$OS" ] && OS="$(uname -sr)"
KERNEL="$(uname -r)"
VIRT="$(systemd-detect-virt 2>/dev/null || echo unknown)"
CPU_MODEL="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
[ -z "$CPU_MODEL" ] && CPU_MODEL="$(uname -m)"
CPU_COUNT="$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)"

# 国家自动探测：只取两位码，任一接口成功即止；失败留空不影响上报
detect_country() {
  [ -n "$COUNTRY" ] && { echo "$COUNTRY" | tr 'a-z' 'A-Z'; return; }
  [ "${NO_GEO:-0}" = "1" ] && { echo ""; return; }
  local cc u
  for u in "https://ipinfo.io/country" "https://api.country.is" "https://ifconfig.co/country-iso"; do
    cc="$(curl -sS -m 4 "$u" 2>/dev/null | grep -oE '[A-Za-z]{2}' | head -1)"
    if [ -n "$cc" ]; then echo "$cc" | tr 'a-z' 'A-Z'; return; fi
  done
  echo ""
}

if [ "$SELFTEST" = "0" ]; then
  COUNTRY="$(detect_country)"
  echo "[agent] v$AGENT_VER  id=$HOST_ID  name=$NAME  country=${COUNTRY:-未知}"
  echo "[agent] OS=$OS  virt=$VIRT  cpu=${CPU_COUNT}x  上报间隔=${INTERVAL}s"
  echo "[agent] 服务端=$SERVER"
fi

# ---------- 采集：全部输出累计值，差分在服务端做 ----------

# CPU 累计 jiffies: "idle total"
read_cpu() {
  set -- $(head -1 /proc/stat)
  local idle=$(( $5 + $6 )) total=0 i
  for (( i = 1; i <= 10; i++ )); do total=$(( total + ${!i:-0} )); done
  echo "$idle $total"
}

# 网络累计字节（排除 lo）: "rx tx"
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

# 磁盘 /: "used total"（字节）
read_disk() {
  df -k / 2>/dev/null | awk 'NR==2 { printf "%d %d\n", $3*1024, $2*1024 }'
}

# TCP 已建立连接数
read_tcp_conns() {
  if command -v ss >/dev/null 2>&1; then
    ss -t state established 2>/dev/null | tail -n +2 | wc -l
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tn 2>/dev/null | grep -c ESTABLISHED
  else
    echo 0
  fi
}

# 当前微秒时间戳（bash 5 用内建变量，老 bash 回落 date）
now_us() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    echo "${EPOCHREALTIME/./}"
  else
    local n
    n=$(date +%s%N 2>/dev/null)
    echo $(( ${n:-0} / 1000 ))
  fi
}

# ---------- TCPing：测 TCP 握手耗时（ms），失败输出 -1 ----------
# 比 ICMP ping 靠得住：很多机房封 ICMP，而 TCP 握手走真实业务路径。
# 时间戳在子进程内部、紧贴 connect 前后取，把 fork/exec 开销（Linux 上约 5-15ms）
# 排除在测量之外，否则短延迟目标会被系统性高估。
# host/port 一律以位置参数传给子 shell，不拼进命令字符串。
tcping() {
  local host="$1" port="$2" out

  # 服务端已校验过目标，这里再挡一道
  case "$host" in
    *[!a-zA-Z0-9.:-]*|'') echo "-1"; return ;;
  esac
  case "$port" in
    ''|*[!0-9]*) echo "-1"; return ;;
  esac

  out=$(timeout "$TCP_TIMEOUT" bash -c '
    if [ -n "${EPOCHREALTIME:-}" ]; then t0=${EPOCHREALTIME/./}
    else t0=$(date +%s%N); t0=$(( t0 / 1000 )); fi
    exec 3<>"/dev/tcp/$1/$2" || exit 1
    if [ -n "${EPOCHREALTIME:-}" ]; then t1=${EPOCHREALTIME/./}
    else t1=$(date +%s%N); t1=$(( t1 / 1000 )); fi
    exec 3<&- 3>&-
    awk -v a="$t0" -v b="$t1" "BEGIN { d=(b-a)/1000; if (d<0) d=0; printf \"%.1f\", d }"
  ' _ "$host" "$port" 2>/dev/null)

  case "$out" in
    ''|*[!0-9.]*) ;;                 # 空或含非数字：连接失败，走下面的兜底
    *) echo "$out"; return ;;
  esac

  # 没有 /dev/tcp 支持（极少数精简 bash）时用 nc 兜底，精度略差但能用
  if command -v nc >/dev/null 2>&1; then
    local t0 t1
    t0=$(now_us)
    if nc -z -w "$TCP_TIMEOUT" -- "$host" "$port" >/dev/null 2>&1; then
      t1=$(now_us)
      awk -v a="$t0" -v b="$t1" 'BEGIN { d=(b-a)/1000; if (d<0) d=0; printf "%.1f\n", d }'
      return
    fi
  fi
  echo "-1"
}

# ---------- 自检：验证 TCPing 在本机是否可靠 ----------
if [ "$SELFTEST" = "1" ]; then
  echo "[agent] TCPing 自检 (bash ${BASH_VERSION%%(*}, $(uname -s))"
  echo
  ok=0; bad=0
  # 预期通：公网常开端口
  for t in "1.1.1.1:443" "8.8.8.8:53" "www.cloudflare.com:443"; do
    h=${t%:*}; p=${t##*:}
    r=$(tcping "$h" "$p")
    if [ "$r" = "-1" ]; then echo "  [!] $t 预期可连但失败了 (若本机无外网可忽略)"; else echo "  [ok] $t -> ${r}ms"; ok=$((ok+1)); fi
  done
  echo
  # 预期不通：本机保留段闭端口 + RFC5737 测试网段（应超时）
  for t in "127.0.0.1:9" "192.0.2.1:80" "198.51.100.7:81"; do
    h=${t%:*}; p=${t##*:}
    r=$(tcping "$h" "$p")
    if [ "$r" = "-1" ]; then echo "  [ok] $t -> 正确判为不可达"; ok=$((ok+1));
    else echo "  [!!] $t 应该不可达，却返回 ${r}ms —— 该环境 /dev/tcp 不可靠"; bad=$((bad+1)); fi
  done
  echo
  if [ "$bad" -gt 0 ]; then
    echo "[agent] 自检未通过：有 $bad 项把不可达目标判成了连通。"
    echo "        这通常出现在 Windows Git Bash / MSYS 等模拟环境，真实 Linux VPS 上不会。"
    exit 1
  fi
  echo "[agent] 自检通过（$ok 项全对），可以正常挂后台运行了。"
  exit 0
fi

# ---------- 探测目标：服务端下发，带 TTL 缓存 ----------
refresh_targets() {
  local now tmp
  now=$(date +%s)
  if [ -s "$TARGETS_FILE" ] && [ $(( now - TARGETS_AT )) -lt "$TARGET_TTL" ]; then return; fi
  tmp="$TMPD/targets.new"
  if curl -sS -m 8 -H "X-Token: $TOKEN" "$SERVER/api/targets" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$TARGETS_FILE"
    TARGETS_AT=$now
    echo "[agent] 已更新探测目标 ($(wc -l < "$TARGETS_FILE") 个)"
  elif [ ! -s "$TARGETS_FILE" ]; then
    echo "[agent] 拉取探测目标失败，本轮跳过延迟测试"
  fi
}

# 并行 TCPing 所有目标，拼成 {"ct":12.3,"cu":-1}
probe_all() {
  local ids=() id host port safe_id
  rm -f "$TMPD"/p_*
  while IFS=$'\t' read -r id host port; do
    [ -z "${id:-}" ] && continue
    safe_id="$(printf '%s' "$id" | tr -cd 'a-z0-9_')"
    [ -z "$safe_id" ] && continue
    ids+=("$safe_id")
    ( tcping "$host" "$port" > "$TMPD/p_$safe_id" ) &
  done < "$TARGETS_FILE"
  wait

  local json="" v
  for id in "${ids[@]}"; do
    v="$(cat "$TMPD/p_$id" 2>/dev/null)"
    case "$v" in
      ''|*[!0-9.-]*) v="-1" ;;
    esac
    [ -n "$json" ] && json="$json,"
    json="$json\"$id\":$v"
  done
  echo "{$json}"
}

# ---------- 主循环 ----------
FAILS=0
while :; do
  refresh_targets

  PINGS="{}"
  [ -s "$TARGETS_FILE" ] && PINGS="$(probe_all)"

  read -r CPU_IDLE CPU_TOTAL   <<< "$(read_cpu)"
  read -r RX TX                <<< "$(read_net)"
  read -r MEM_USED MEM_TOTAL   <<< "$(read_mem)"
  read -r DISK_USED DISK_TOTAL <<< "$(read_disk)"
  LOAD1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
  UPTIME=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || echo 0)
  TCPC=$(read_tcp_conns)

  JSON=$(printf \
'{"id":"%s","name":"%s","country":"%s","os":"%s","kernel":"%s","virt":"%s","cpuModel":"%s","cpuCount":%d,"cpuIdle":%s,"cpuTotal":%s,"memUsed":%s,"memTotal":%s,"diskUsed":%s,"diskTotal":%s,"rxBytes":%s,"txBytes":%s,"load1":%s,"uptime":%s,"tcpConns":%s,"agentVer":"%s","pings":%s}' \
    "$HOST_ID" "$NAME" "$COUNTRY" "$OS" "$KERNEL" "$VIRT" "$CPU_MODEL" "$CPU_COUNT" \
    "$CPU_IDLE" "$CPU_TOTAL" "$MEM_USED" "$MEM_TOTAL" "$DISK_USED" "$DISK_TOTAL" \
    "$RX" "$TX" "$LOAD1" "$UPTIME" "$TCPC" "$AGENT_VER" "$PINGS")

  if curl -sS -m 8 -X POST "$SERVER/api/report" \
       -H "X-Token: $TOKEN" -H 'Content-Type: application/json' \
       -d "$JSON" >/dev/null 2>&1; then
    FAILS=0
  else
    FAILS=$(( FAILS + 1 ))
    echo "[agent] $(date '+%H:%M:%S') 上报失败 (连续 $FAILS 次)"
    # 连续失败时退避，避免服务端挂了还在死打
    [ "$FAILS" -ge 3 ] && sleep $(( INTERVAL * 2 ))
  fi
  sleep "$INTERVAL"
done
