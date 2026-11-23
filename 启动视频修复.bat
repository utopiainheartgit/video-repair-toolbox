@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 视频工具箱 - 修复 / 合并 (Windows)

echo ============================================
echo   视频工具箱 - 修复 / 合并 (Windows)
echo ============================================
echo.

set "PORT=8731"
if defined VT_PORT set "PORT=%VT_PORT%"
set "URL=http://127.0.0.1:%PORT%"

where node >nul 2>&1
if errorlevel 1 (
  echo [X] 未找到 Node.js，请先安装: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem --- ffmpeg / ffprobe: explicit override > vendor bundle > PATH ---
if not defined FFMPEG_BIN (
  for /f "delims=" %%i in ('where ffmpeg 2^>nul') do set "FFMPEG_BIN=%%i"
)
if not defined FFMPEG_BIN if exist "%~dp0vendor\ffmpeg\bin\ffmpeg.exe" set "FFMPEG_BIN=%~dp0vendor\ffmpeg\bin\ffmpeg.exe"
if not defined FFMPEG_BIN (
  echo [X] 未找到 ffmpeg。请安装后加入 PATH，或放到：
  echo     vendor\ffmpeg\bin\ffmpeg.exe
  echo.
  pause
  exit /b 1
)

if not defined FFPROBE_BIN (
  for /f "delims=" %%i in ('where ffprobe 2^>nul') do set "FFPROBE_BIN=%%i"
)
if not defined FFPROBE_BIN if exist "%~dp0vendor\ffmpeg\bin\ffprobe.exe" set "FFPROBE_BIN=%~dp0vendor\ffmpeg\bin\ffprobe.exe"
if not defined FFPROBE_BIN (
  echo [X] 未找到 ffprobe。请安装后加入 PATH，或放到：
  echo     vendor\ffmpeg\bin\ffprobe.exe
  echo.
  pause
  exit /b 1
)

if not defined UNTRUNC_BIN if exist "%~dp0vendor\untrunc\untrunc.exe" set "UNTRUNC_BIN=%~dp0vendor\untrunc\untrunc.exe"

for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo [OK] Node:     %NODE_VER%
echo [OK] ffmpeg:   %FFMPEG_BIN%
echo [OK] ffprobe:  %FFPROBE_BIN%
if defined UNTRUNC_BIN (
  echo [OK] untrunc: %UNTRUNC_BIN%
) else (
  echo [!] untrunc 未安装：moov 索引缺失的文件无法用参考重建，其余修复不受影响
)
echo.

netstat -ano | findstr /C:":%PORT% " | findstr /I "LISTENING" >nul
if not errorlevel 1 (
  echo 服务已在运行，直接打开网页。
  start "" "%URL%"
  pause
  exit /b 0
)

echo 启动本地服务（仅监听 127.0.0.1，不对外网开放）...
start "" "%URL%"
node server.mjs
if errorlevel 1 (
  echo.
  echo [X] 服务启动失败，请检查上方错误信息。
  pause
)
