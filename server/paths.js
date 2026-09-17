import fs from 'fs';
import path from 'path';

/**
 * 应用路径集中在这里，用于同时支持两种运行方式：
 *
 * 1. 开发 / npm start：从仓库根目录运行，路径基于 process.cwd()
 * 2. 打包成单文件 exe（Node SEA）：SEA 入口会在启动前解出静态资源并注入以下环境变量
 *
 *   LAN_SHARE_HOME       数据根目录（config.json / uploads / data 所在处，默认 exe 同级目录）
 *   LAN_SHARE_WEB_DIR    前端静态目录（client/dist）
 *   LAN_SHARE_ADMIN_DIR  管理后台页面目录（admin）
 *   LAN_SHARE_SQL_WASM   sql.js 的 wasm 文件绝对路径（打包后从 exe 内解出）
 */

// 注意：这里刻意不用 import.meta.url —— 打包成 CJS 单文件时它不可用。
// 开发模式下所有 npm 脚本都在仓库根目录执行（启动脚本也先 cd 到根目录），
// 因此 process.cwd() 就是仓库根目录。
export const APP_ROOT = process.env.LAN_SHARE_HOME
  ? path.resolve(process.env.LAN_SHARE_HOME)
  : process.cwd();

export const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const DEFAULT_UPLOAD_DIR = path.join(APP_ROOT, 'uploads');

export const WEB_DIR = process.env.LAN_SHARE_WEB_DIR
  ? path.resolve(process.env.LAN_SHARE_WEB_DIR)
  : path.join(APP_ROOT, 'client', 'dist');

export const ADMIN_DIR = process.env.LAN_SHARE_ADMIN_DIR
  ? path.resolve(process.env.LAN_SHARE_ADMIN_DIR)
  : path.join(APP_ROOT, 'admin');

export const SQL_WASM_PATH = process.env.LAN_SHARE_SQL_WASM || '';

/** 打包成 exe 运行时为 true（SEA 入口会设置 LAN_SHARE_HOME） */
export const IS_PACKAGED = Boolean(process.env.LAN_SHARE_HOME);

/**
 * 版本号：打包成 exe 时由构建脚本通过 esbuild define 注入 __APP_VERSION__；
 * 开发模式没有这个常量（typeof 判断不会抛错），退回读 package.json。
 */
function resolveVersion() {
  if (typeof __APP_VERSION__ !== 'undefined') {
    return __APP_VERSION__;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version || 'dev';
  } catch (error) {
    return 'dev';
  }
}

export const APP_VERSION = resolveVersion();
