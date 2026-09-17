/**
 * 用真实浏览器验证「已构建的单文件 exe」是否可用
 *
 *   node scripts/verify-exe.mjs                       # 默认 http://localhost:13080
 *   node scripts/verify-exe.mjs http://localhost:13080
 *
 * 前置：先双击 exe（或从命令行启动它），再运行本脚本。
 * 覆盖：页面加载（资源来自 exe 内解出的静态文件）、主题切换、上传、搜索、
 *      视频真实播放（解码级验证）、下载、管理后台；结束后清理自己上传的文件。
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BASE = (process.argv[2] || 'http://localhost:13080').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_URL || BASE.replace(/:(\d+)/, (m, p) => `:${Number(p) + 1}`);

const results = [];
let failures = 0;
let skipped = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function skip(name, reason) {
  skipped++;
  console.log(`⚠️  ${name} — 已跳过：${reason}`);
}

async function waitVisible(locator, timeout = 8000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch (error) {
    return false;
  }
}

/** 准备一段可播放的 WebM（Playwright 自带 Chromium 不含 H.264） */
function ensureSampleVideo() {
  const fixture = path.join(process.cwd(), 'test_data', 'preview-sample.webm');
  if (fs.existsSync(fixture)) return fixture;

  try {
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    execFileSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libvorbis',
      '-y', fixture
    ], { stdio: 'ignore' });
  } catch (error) {
    return null;
  }
  return fs.existsSync(fixture) ? fixture : null;
}

async function main() {
  console.log(`验证目标：${BASE}（后台 ${ADMIN}）\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, baseURL: BASE });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const createdIds = [];

  try {
    // 1. 页面加载（静态资源全部来自 exe 内解出的文件）
    const response = await page.goto('/');
    await page.waitForLoadState('networkidle');
    record('首页可访问', response?.status() === 200, `HTTP ${response?.status()}`);
    record('页面标题正确', (await page.title()).includes('本地文件交互系统'), await page.title());

    // 2. 主题（默认白天 / 可切夜间）
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    record('默认白天主题', await theme() === 'light', await theme());
    await page.locator('.theme-toggle').click();
    await page.waitForTimeout(300);
    record('主题可切换到夜间', await theme() === 'dark', await theme());
    await page.locator('.theme-toggle').click();
    await page.waitForTimeout(300);

    // 3. 上传（真实浏览器 multipart）
    const fileName = `exe-verify-${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from('browser upload to exe')
    });
    const card = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: fileName }).first();
    record('浏览器上传后出现在列表', await waitVisible(card, 15000), fileName);

    const listed = await (await context.request.get('/api/files')).json();
    const created = listed.find(item => item.filename === fileName);
    if (created) createdIds.push(created.id);

    // 4. 搜索过滤
    const search = page.locator('input[type="search"]');
    if (await waitVisible(search, 5000)) {
      await search.fill(fileName);
      await page.waitForTimeout(300);
      const matchCount = await page.locator('.bg-surface-3.rounded-2xl').count();
      record('搜索可按文件名过滤', matchCount === 1, `匹配 ${matchCount} 条`);
      await search.fill('');
    } else {
      record('搜索框存在', false, '未找到搜索框');
    }

    // 5. 下载内容正确
    if (created) {
      const download = await context.request.get(`/api/download/${created.id}`);
      record('下载内容一致', (await download.text()) === 'browser upload to exe', `HTTP ${download.status()}`);
    }

    // 6. 视频真实播放（解码级）
    const samplePath = ensureSampleVideo();
    if (!samplePath) {
      skip('视频在线预览（真实播放）', '本机无 ffmpeg 且无样例视频');
    } else {
      const videoName = `exe-verify-${Date.now()}.webm`;
      const uploadResponse = await context.request.post('/api/upload', {
        multipart: { files: { name: videoName, mimeType: 'video/webm', buffer: fs.readFileSync(samplePath) } }
      });
      const videoFile = (await uploadResponse.json()).files[0];
      createdIds.push(videoFile.id);

      await page.reload();
      await page.waitForLoadState('networkidle');
      const videoCard = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: videoName }).first();
      if (await waitVisible(videoCard, 10000)) {
        await videoCard.getByRole('button', { name: '预览', exact: true }).click();
        await waitVisible(page.locator('div[role="dialog"] video'), 10000);

        const playback = await page.evaluate(async () => {
          const video = document.querySelector('video');
          if (!video) return { error: 'no video' };
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            // readyState>=3 说明已解码出可播数据；时间轴推进或处于播放状态即证明在播
            if (video.readyState >= 3 && (video.currentTime > 0.2 || video.paused === false)) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          return {
            readyState: video.readyState,
            currentTime: Number(video.currentTime.toFixed(2)),
            duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
            paused: video.paused,
            width: video.videoWidth,
            height: video.videoHeight,
            error: video.error ? `${video.error.code}: ${video.error.message}` : null
          };
        });

        const played = !playback.error && playback.readyState >= 3
          && (playback.currentTime > 0.2 || playback.paused === false);
        record('视频真的在播放（解码并推进时间轴）', played,
          playback.error ? playback.error
            : `readyState=${playback.readyState} 时长=${playback.duration}s 已播=${playback.currentTime}s 分辨率=${playback.width}x${playback.height} paused=${playback.paused}`);

        await page.keyboard.press('Escape');
      } else {
        record('视频卡片出现', false, videoName);
      }
    }

    // 7. 管理后台
    const adminPage = await context.newPage();
    const adminResponse = await adminPage.goto(ADMIN);
    await adminPage.waitForLoadState('networkidle');
    await adminPage.waitForTimeout(800);
    record('管理后台可访问', adminResponse?.status() === 200, `HTTP ${adminResponse?.status()}`);
    const fileCount = (await adminPage.locator('#fileCount').textContent())?.trim();
    record('后台状态卡片有数据', Boolean(fileCount) && fileCount !== '-', `文件总数=${fileCount}`);
    await adminPage.close();

    record('页面无 JavaScript 运行时错误', pageErrors.length === 0, pageErrors.join(' | ') || '无');
  } finally {
    // 用 Playwright 的请求上下文清理：它的连接随 context 一起关闭，
    // 不会像裸 fetch 那样在进程退出时留下未关闭的 socket（Windows 下会触发 libuv 断言）
    for (const id of createdIds) {
      await context.request.delete(`/api/files/${id}`).catch(() => {});
    }
    await context.close();
    await browser.close();
  }

  console.log('\n' + '='.repeat(56));
  console.log(`exe 验证结果：${results.length - failures}/${results.length} 通过` +
    (skipped ? `，${skipped} 项跳过` : ''));
  console.log('='.repeat(56));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('验证脚本异常终止:', error);
  process.exit(2);
});
