/**
 * 打包成单文件 exe 时的入口（Node SEA）
 *
 * 职责：把编译进 exe 的静态资源解出来 → 注入环境变量 → 启动服务。
 * 这个文件会被 esbuild 与 server 代码一起打成单个 CJS 文件，
 * 再由 postject 注入到 node.exe 副本里，所以它必须保持 CommonJS 写法
 * （SEA 的主脚本只支持 CJS，不能用 import.meta / 顶层 await）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const sea = require('node:sea');

/** 数据目录：优先 exe 所在目录；不可写（如放在 Program Files）时退回用户目录 */
function pickHome() {
  const exeDir = path.dirname(process.execPath);
  try {
    fs.accessSync(exeDir, fs.constants.W_OK);
    return exeDir;
  } catch (error) {
    const fallback = path.join(os.homedir(), 'LANFileShare');
    fs.mkdirSync(fallback, { recursive: true });
    console.log(`⚠️  ${exeDir} 不可写，数据目录改用 ${fallback}`);
    return fallback;
  }
}

const home = pickHome();
const runtimeDir = path.join(home, '.runtime');

// 解出静态资源。用清单里的版本号做缓存判断，避免每次启动都重写一遍。
const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
const stampPath = path.join(runtimeDir, '.stamp');

let upToDate = false;
try {
  upToDate = fs.readFileSync(stampPath, 'utf8') === manifest.version;
} catch (error) {
  upToDate = false;
}

if (!upToDate) {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  for (const key of manifest.files) {
    const target = path.join(runtimeDir, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(sea.getAsset(key)));
  }
  fs.writeFileSync(stampPath, manifest.version);
  console.log(`📦 已解出内置资源 → ${runtimeDir}`);
}

// 告知服务代码各路径（见 server/paths.js）
process.env.LAN_SHARE_HOME = home;
process.env.LAN_SHARE_WEB_DIR = path.join(runtimeDir, 'web');
process.env.LAN_SHARE_ADMIN_DIR = path.join(runtimeDir, 'admin');
process.env.LAN_SHARE_SQL_WASM = path.join(runtimeDir, 'sql-wasm.wasm');

// 启动服务（与 server 代码一起打进同一个文件）
require('../server/server.js');
