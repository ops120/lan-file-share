#!/bin/bash

echo ""
echo "========================================"
echo "   本地文件交互系统 - 启动脚本"
echo "========================================"
echo ""
echo "正在启动服务..."
echo ""

cd "$(dirname "$0")"

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "[错误] 未检测到 Node.js，请先安装 Node.js"
    echo "下载地址: https://nodejs.org/"
    exit 1
fi

# 检查依赖是否安装
if [ ! -d "node_modules" ]; then
    echo "[提示] 首次运行，正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[错误] 依赖安装失败"
        exit 1
    fi
fi

# 检查前端构建产物（dist 不进版本库，新克隆的仓库必须先构建，否则页面打不开）
if [ ! -f "client/dist/index.html" ]; then
    echo "[提示] 未找到前端构建产物，正在构建..."
    npm run build
    if [ $? -ne 0 ]; then
        echo "[错误] 前端构建失败"
        exit 1
    fi
fi

# 启动服务
echo "[提示] 服务启动中，请稍候..."
echo ""
npm start
