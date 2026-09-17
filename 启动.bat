@echo off
echo.
echo ========================================
echo    本地文件交互系统 - 启动脚本
echo ========================================
echo.
echo 正在启动服务...
echo.

cd /d "%~dp0"

REM 检查 Node.js 是否安装
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

REM 检查依赖是否安装
if not exist "node_modules\" (
    echo [提示] 首次运行，正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

REM 检查前端构建产物（dist 不进版本库，新克隆的仓库必须先构建，否则页面打不开）
if not exist "client\dist\index.html" (
    echo [提示] 未找到前端构建产物，正在构建...
    call npm run build
    if %errorlevel% neq 0 (
        echo [错误] 前端构建失败
        pause
        exit /b 1
    )
)

REM 启动服务
echo [提示] 服务启动中，请稍候...
echo.
call npm start

pause
