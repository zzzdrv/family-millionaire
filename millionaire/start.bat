@echo off
chcp 65001 >nul
title 家庭百万富翁
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)
echo 正在启动，请不要关闭这个窗口……
node server.js
echo.
echo 游戏已停止。
pause
