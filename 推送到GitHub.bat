@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "GH=%ProgramFiles%\GitHub CLI\gh.exe"
if not exist "%GH%" set "GH=%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe"
if not exist "%GH%" (
  echo.
  echo  X 找不到 GitHub CLI，请先执行: winget install --id GitHub.cli
  echo.
  pause
  exit /b 1
)

echo ==========================================================
echo   VPS 探针 - 一键推送到 GitHub
echo ==========================================================
echo.

"%GH%" auth status >nul 2>&1
if errorlevel 1 (
  echo  第 1 步 / 共 2 步：登录 GitHub
  echo.
  echo  接下来会问你几个问题，照这样选就行：
  echo.
  echo    What account do you want to log into?   选 GitHub.com    直接回车
  echo    What is your preferred protocol?        选 HTTPS         直接回车
  echo    Authenticate Git with your credentials? 选 Yes           直接回车
  echo    How would you like to authenticate?     选 Login with a web browser  直接回车
  echo.
  echo  然后屏幕会显示一个八位验证码，例如 ABCD-1234
  echo  把它记住，按回车会自动打开浏览器，粘贴进去点 Authorize 即可。
  echo.
  echo  ----------------------------------------------------------
  echo.
  "%GH%" auth login
  if errorlevel 1 (
    echo.
    echo  X 登录没成功，可以关掉窗口重新双击本文件再试一次。
    echo.
    pause
    exit /b 1
  )
)

echo.
echo  第 2 步 / 共 2 步：创建仓库并推送
echo.

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  "%GH%" repo create vps-probe --public --source=. --remote=origin --push
) else (
  echo  已存在 origin 远程，直接推送
  git push -u origin main
)

if errorlevel 1 (
  echo.
  echo  X 推送失败。如果提示仓库名已被占用，
  echo    可以在 GitHub 上删掉同名仓库后重试，或改用 push-to-github.sh 指定别的名字。
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================================
for /f "delims=" %%u in ('"%GH%" repo view --json url -q .url') do set "URL=%%u"
echo   完成！仓库地址： %URL%
echo ==========================================================
echo.
echo  接下来在 VPS 上部署 Agent，把下面三条粘过去：
echo.
echo    curl -sL %URL:github.com=raw.githubusercontent.com%/main/agent.sh -o agent.sh
echo    chmod +x agent.sh
echo    nohup ./agent.sh http://服务端IP:8790 你的TOKEN "机器名" ^>/dev/null 2^>^&1 ^&
echo.
pause
