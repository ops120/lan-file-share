/**
 * 构建单文件 Windows exe（Node SEA）
 *
 *   npm run build:exe
 *
 * 流程：构建前端 → esbuild 打包服务端为单文件 CJS → 生成 SEA 配置与 blob
 *      → 复制 node.exe 并注入 blob（postject）→ 组装分发目录
 *
 * 产物：dist-exe/本地文件交互系统/<...>
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build as esbuild } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'tmp', 'exe-build');
const OUT_DIR = path.join(ROOT, 'dist-exe');
const APP_DIR_NAME = '本地文件交互系统';
const EXE_NAME = '本地文件交互系统.exe';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function walkFiles(dir, baseDir = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, baseDir));
    } else {
      out.push(path.relative(baseDir, full).split(path.sep).join('/'));
    }
  }
  return out;
}

async function main() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // ---------- 1. 构建前端 ----------
  log('1/6', '构建前端（client/dist）');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });

  const webDir = path.join(ROOT, 'client', 'dist');
  if (!fs.existsSync(path.join(webDir, 'index.html'))) {
    throw new Error('前端构建产物缺失：client/dist/index.html');
  }

  // ---------- 2. esbuild 打包服务端 ----------
  log('2/6', '打包服务端为单文件 CJS');
  const bundlePath = path.join(BUILD_DIR, 'sea-main.cjs');
  await esbuild({
    entryPoints: [path.join(ROOT, 'scripts', 'sea-entry.cjs')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: bundlePath,
    // ws 的可选加速模块，装了就用、没装就走纯 JS 实现
    external: ['bufferutil', 'utf-8-validate'],
    // 把版本号打进产物，exe 启动时会显示（见 server/paths.js 的 APP_VERSION）
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
    banner: {
      js: '/* 本地文件交互系统 (LAN File Share) — Copyright 2026 ops120 — Apache-2.0 */'
    },
    logLevel: 'warning'
  });
  const bundleSize = (fs.statSync(bundlePath).size / 1024 / 1024).toFixed(1);
  log('  ', `打包完成：${bundleSize} MB`);

  // ---------- 3. 收集要内嵌的静态资源 ----------
  log('3/6', '收集静态资源（前端页面 / 管理后台 / sql.js wasm）');
  const assets = {};
  const manifestFiles = [];

  for (const rel of walkFiles(webDir)) {
    const key = `web/${rel}`;
    assets[key] = path.join(webDir, rel);
    manifestFiles.push(key);
  }

  for (const rel of walkFiles(path.join(ROOT, 'admin'))) {
    const key = `admin/${rel}`;
    assets[key] = path.join(ROOT, 'admin', rel);
    manifestFiles.push(key);
  }

  const wasmSource = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  if (!fs.existsSync(wasmSource)) {
    throw new Error(`未找到 sql.js wasm：${wasmSource}`);
  }
  assets['sql-wasm.wasm'] = wasmSource;
  manifestFiles.push('sql-wasm.wasm');

  // 清单 + 版本号（用资源内容哈希做缓存判断，避免每次启动都重新解包）
  const versionHash = crypto.createHash('sha256');
  versionHash.update(fs.readFileSync(bundlePath));
  for (const key of manifestFiles.slice().sort()) {
    versionHash.update(key);
    versionHash.update(fs.readFileSync(assets[key]));
  }
  const manifest = { version: versionHash.digest('hex').slice(0, 16), files: manifestFiles };
  const manifestPath = path.join(BUILD_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assets['manifest.json'] = manifestPath;

  log('  ', `内嵌 ${manifestFiles.length} 个资源，版本 ${manifest.version}`);

  // ---------- 4. 生成 SEA blob ----------
  log('4/6', '生成 SEA blob（node --experimental-sea-config）');
  const seaConfig = {
    main: bundlePath,
    output: path.join(BUILD_DIR, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets
  };
  const seaConfigPath = path.join(BUILD_DIR, 'sea-config.json');
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

  // ---------- 5. 复制 node.exe 并注入 ----------
  log('5/6', '复制 node.exe 并注入 blob（postject）');
  const appDir = path.join(OUT_DIR, APP_DIR_NAME);
  fs.mkdirSync(appDir, { recursive: true });
  const exePath = path.join(appDir, EXE_NAME);
  fs.copyFileSync(process.execPath, exePath);

  execFileSync('npx', [
    'postject', exePath, 'NODE_SEA_BLOB', seaConfig.output,
    '--sentinel-fuse', SEA_FUSE
  ], { cwd: ROOT, stdio: 'inherit', shell: true });

  // ---------- 6. 组装分发目录 ----------
  log('6/6', '组装分发目录');
  fs.writeFileSync(path.join(appDir, 'config.json'), JSON.stringify({
    host: '0.0.0.0',
    port: 13080,
    uploadDir: './uploads',
    maxFileSize: 1073741824,
    autoCleanHours: 24
  }, null, 2), 'utf-8');

  // Apache-2.0 第 4 条：再分发必须附带许可证与 NOTICE
  for (const file of ['LICENSE', 'NOTICE']) {
    const source = path.join(ROOT, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(appDir, file));
    }
  }

  fs.writeFileSync(path.join(appDir, '使用说明.txt'), `
本地文件交互系统 v${APP_VERSION}（单文件版）
作者：你们喜爱的老王  ·  B 站 @你们喜爱的老王  ·  GitHub @ops120
========================================

启动
  双击「${EXE_NAME}」，然后看窗口里列出的访问地址。

手机上访问
  1. 确保手机和电脑连同一个 WiFi
  2. 在电脑浏览器打开 http://localhost:13080 ，点「显示连接二维码」
  3. 页面「服务地址」处可选择手机能连通的网段，二维码会跟随所选地址

数据放在哪
  uploads/        上传的文件
  data/           文件索引数据库
  .runtime/       从 exe 内解出的网页资源（可删，会自动重建）
  config.json     端口、单文件上限、过期时长等配置（改完需重启）

默认端口
  13080  主服务（网页 + 接口）
  13081  管理后台（仅本机可访问）

注意
  - 文件默认 24 小时过期清理，想长期保留请点「☆ 收藏」
  - 局域网内任何设备都能看到文件列表，请只在可信网络使用
  - 首次运行 Windows 可能提示"未知发布者"（exe 未做数字签名），选择"仍要运行"即可

关闭
  在窗口里按 Ctrl+C，或直接关闭窗口。
`.trimStart(), 'utf-8');

  const exeSize = (fs.statSync(exePath).size / 1024 / 1024).toFixed(0);
  console.log('');
  console.log(`✅ 构建完成（v${APP_VERSION}）`);
  console.log(`   ${exePath}  （${exeSize} MB）`);
  console.log(`   分发目录：${appDir}`);
}

main().catch((error) => {
  console.error('❌ 构建失败:', error.message);
  process.exit(1);
});
