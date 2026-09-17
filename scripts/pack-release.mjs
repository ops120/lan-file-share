/**
 * 打发布包：构建 exe → 压缩为 zip → 生成校验和
 *
 *   npm run release
 *
 * 产物：
 *   release/本地文件交互系统-v<版本>-win-x64.zip
 *   release/SHA256SUMS.txt
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_DIR_NAME = '本地文件交互系统';
const RELEASE_DIR = path.join(ROOT, 'release');

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
const zipName = `${APP_DIR_NAME}-v${version}-win-x64.zip`;

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

/** 压缩：优先用 Windows 自带的 bsdtar（libarchive 支持写 zip），失败再退回 PowerShell */
function createZip(sourceDir, zipPath) {
  const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

  if (fs.existsSync(bsdtar)) {
    execFileSync(bsdtar, ['-a', '-c', '-f', zipPath, '-C', path.dirname(sourceDir), APP_DIR_NAME], {
      stdio: 'inherit'
    });
    return 'bsdtar';
  }

  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -LiteralPath '${sourceDir}' -DestinationPath '${zipPath}' -Force`
  ], { stdio: 'inherit' });
  return 'Compress-Archive';
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function main() {
  // 1. 构建 exe（含前端构建、SEA 打包、postject 注入）
  log('1/4', `构建 exe（v${version}）`);
  execFileSync(process.execPath, [path.join(__dirname, 'build-exe.mjs')], { cwd: ROOT, stdio: 'inherit' });

  const appDir = path.join(ROOT, 'dist-exe', APP_DIR_NAME);
  if (!fs.existsSync(path.join(appDir, `${APP_DIR_NAME}.exe`))) {
    throw new Error('未找到构建产物，先确认 build:exe 是否成功');
  }

  // 清理构建过程中可能残留的运行时数据，保证发布包是干净的。
  // 这些目录是 exe 实际运行（测试/使用）时在分发目录里生成的，绝不能打进发布包：
  // .runtime 是 exe 解出的内置资源缓存、uploads 是用户上传、data 是文件索引库。
  for (const leftover of ['.runtime', 'uploads', 'data', 'exe-console.log', 'run.log']) {
    fs.rmSync(path.join(appDir, leftover), { recursive: true, force: true });
  }

  // 压缩前强制校验：一旦仍残留运行时目录就直接失败，把问题拦在这里而不是发出脏包。
  const allowedEntries = new Set(['config.json', 'LICENSE', 'NOTICE', '使用说明.txt', `${APP_DIR_NAME}.exe`]);
  const leftovers = fs.readdirSync(appDir).filter(name => !allowedEntries.has(name));
  if (leftovers.length > 0) {
    throw new Error(`发布目录含非预期内容，已中止：${leftovers.join(', ')}`);
  }

  // 2. 压缩
  log('2/4', '压缩为 zip');
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const zipPath = path.join(RELEASE_DIR, zipName);
  const tool = createZip(appDir, zipPath);
  log('  ', `使用 ${tool} 完成压缩`);

  // 3. 校验和
  log('3/4', '生成 SHA-256 校验和');
  const digest = sha256(zipPath);
  const sumsPath = path.join(RELEASE_DIR, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, `${digest}  ${zipName}\n`, 'utf-8');

  // 4. 汇总
  const zipSize = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  const exeSize = (fs.statSync(path.join(appDir, `${APP_DIR_NAME}.exe`)).size / 1024 / 1024).toFixed(0);
  log('4/4', '完成');

  console.log('');
  console.log(`✅ 发布包已生成（v${version}）`);
  console.log(`   ${zipPath}   ${zipSize} MB（exe ${exeSize} MB）`);
  console.log(`   ${sumsPath}`);
  console.log(`   SHA-256: ${digest}`);
  console.log('');
  console.log('   包内文件：');
  for (const entry of fs.readdirSync(appDir)) {
    console.log(`     ${entry}`);
  }
}

main().catch((error) => {
  console.error('❌ 打包失败:', error.message);
  process.exit(1);
});
