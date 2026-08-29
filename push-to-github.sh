#!/usr/bin/env bash
#
# 一键把本仓库推到你的 GitHub
#
#   ./push-to-github.sh            # 仓库名默认 vps-probe，公开
#   ./push-to-github.sh 我的探针    # 自定义仓库名
#   PRIVATE=1 ./push-to-github.sh  # 建成私有仓库
#
# 前置条件：先跑一次 gh auth login（浏览器里点几下授权即可，只需做一次）
#
set -euo pipefail

REPO_NAME="${1:-vps-probe}"
VISIBILITY="--public"
[ "${PRIVATE:-0}" = "1" ] && VISIBILITY="--private"

# Windows 下 gh 装在 Program Files，Git Bash 默认不在 PATH 里
export PATH="$PATH:/c/Program Files/GitHub CLI:/usr/local/bin"

if ! command -v gh >/dev/null 2>&1; then
  echo "✗ 找不到 gh 命令。先安装 GitHub CLI: winget install --id GitHub.cli"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "✗ 还没登录 GitHub。请先执行下面这条命令，按提示在浏览器授权："
  echo ""
  echo "    gh auth login"
  echo ""
  echo "  选项照这样选：GitHub.com → HTTPS → Yes → Login with a web browser"
  echo "  登录完成后重新跑本脚本即可。"
  exit 1
fi

cd "$(dirname "$0")"

if git remote get-url origin >/dev/null 2>&1; then
  echo "→ 已有 origin 远程，直接推送"
  git push -u origin main
else
  echo "→ 创建仓库 $REPO_NAME 并推送"
  gh repo create "$REPO_NAME" $VISIBILITY --source=. --remote=origin --push
fi

URL="$(gh repo view --json url -q .url)"
echo ""
echo "✓ 完成: $URL"
echo ""
echo "接下来在 VPS 上部署 Agent："
echo "  curl -sL ${URL/github.com/raw.githubusercontent.com}/main/agent.sh -o agent.sh"
echo "  chmod +x agent.sh"
echo "  nohup ./agent.sh http://服务端IP:8790 你的TOKEN \"机器名\" >/dev/null 2>&1 &"
