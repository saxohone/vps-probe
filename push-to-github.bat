@echo off
setlocal
cd /d "%~dp0"

set "GH=%ProgramFiles%\GitHub CLI\gh.exe"
if not exist "%GH%" set "GH=%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe"
if not exist "%GH%" (
  echo.
  echo  [ERROR] GitHub CLI not found.
  echo  Please run: winget install --id GitHub.cli
  echo.
  pause
  exit /b 1
)

echo ==========================================================
echo    VPS Probe - Push to GitHub
echo ==========================================================
echo.

"%GH%" auth status >nul 2>&1
if errorlevel 1 goto DOLOGIN
goto DOPUSH

:DOLOGIN
echo  STEP 1 of 2 : Login to GitHub
echo.
echo  You will be asked 4 questions.
echo  Just press ENTER on all of them - the defaults are correct.
echo.
echo    1. What account do you want to log into?        [ENTER]
echo    2. What is your preferred protocol?             [ENTER]
echo    3. Authenticate Git with your credentials?      [ENTER]
echo    4. How would you like to authenticate?          [ENTER]
echo.
echo  Then an 8-character code appears, like  ABCD-1234
echo  Remember it, press ENTER to open the browser,
echo  paste the code and click the green Authorize button.
echo.
echo ----------------------------------------------------------
echo.
"%GH%" auth login
if errorlevel 1 (
  echo.
  echo  [ERROR] Login failed. Close this window and double-click again to retry.
  echo.
  pause
  exit /b 1
)

:DOPUSH
echo.
echo  STEP 2 of 2 : Create repository and push
echo.

git remote get-url origin >nul 2>&1
if errorlevel 1 goto CREATEREPO
echo  Remote "origin" already exists, pushing directly.
git push -u origin main
goto CHECKPUSH

:CREATEREPO
"%GH%" repo create vps-probe --public --source=. --remote=origin --push

:CHECKPUSH
if errorlevel 1 (
  echo.
  echo  [ERROR] Push failed.
  echo  If the repo name is taken, delete it on GitHub and retry.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%u in ('"%GH%" repo view --json url -q .url') do set "URL=%%u"
set "RAW=%URL:github.com=raw.githubusercontent.com%"

echo.
echo ==========================================================
echo    DONE! Repository URL:
echo    %URL%
echo ==========================================================
echo.
echo  Next, deploy the agent on your VPS - copy these 3 lines:
echo.
echo    curl -sL %RAW%/main/agent.sh -o agent.sh
echo    chmod +x agent.sh
echo    nohup ./agent.sh http://YOUR_SERVER_IP:8790 YOUR_TOKEN "name" ^>/dev/null 2^>^&1 ^&
echo.
pause
