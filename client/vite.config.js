import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import { fileURLToPath } from 'url';

// 代理目标跟随项目 config.json 的端口，避免服务端改端口后 dev 环境整体 404
function resolveServerPort() {
  try {
    const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (Number.isInteger(config.port)) {
      return config.port;
    }
  } catch (error) {
    console.warn('未能读取 config.json，dev 代理回退到 8080');
  }
  return 8080;
}

const target = `http://localhost:${resolveServerPort()}`;

const proxy = {
  // ws: true 让 /api 的 WebSocket 升级请求也能转发到后端，
  // 否则 dev 模式下实时同步永远连不上（会无限重连）
  '/api': { target, changeOrigin: true, ws: true },
  '/download': { target, changeOrigin: true }
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy
  }
});
