/**
 * 真实浏览器端到端验收脚本（独立于 Playwright 测试套件，不参与自动收集）
 *
 * 用法：node tests/browser-acceptance.mjs
 * 前置：主服务已运行在 http://localhost:13080（管理后台 http://localhost:13081）
 *
 * 覆盖：首页加载、中文文件名上传/显示、收藏与持久化、文件二维码、下载文件名保真、
 *       下载落地页、删除、管理后台状态与文件列表；全程输出截图到 tmp/test-results/acceptance/。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const BASE = process.env.BASE_URL || 'http://localhost:13080';
const ADMIN = process.env.ADMIN_URL || 'http://localhost:13081';
// 生成物统一放 tmp/（该目录不纳入版本库）
const SHOT_DIR = path.join(process.cwd(), 'tmp', 'test-results', 'acceptance');

const CHINESE_NAME = '验收-测试文档-中文名.txt';
const CHINESE_CONTENT = 'acceptance check 中文内容';

const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

// 本脚本不依赖 @playwright/test 的 expect，这里用 waitFor 做可见性轮询
async function waitVisible(locator, timeout = 5000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch (error) {
    return false;
  }
}

const skipped = [];

function recordSkipped(name, reason) {
  skipped.push({ name, reason });
  console.log(`⚠️  ${name} — 已跳过：${reason}`);
}

/**
 * 准备一段可播放的样例视频。
 * 用 WebM(VP8/Vorbis)：Playwright 自带的 Chromium 不含 H.264 专有编解码器，
 * 而 WebM 是它内置支持的，这样才能验证"真的解码播放"而不是只看元素是否存在。
 */
function ensureSampleVideo() {
  const fixture = path.join(process.cwd(), 'test_data', 'preview-sample.webm');
  if (fs.existsSync(fixture)) {
    return fixture;
  }

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
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const localFile = path.join(process.cwd(), CHINESE_NAME);
  fs.writeFileSync(localFile, CHINESE_CONTENT);

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    // 1. 首页加载
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    record('首页标题正确', title.includes('本地文件交互系统'), title);
    await shot(page, '01-home');

    // 2. 多网卡地址展示与选择（本机可能同时有以太网/无线/虚拟网卡/VPN）
    const info = await (await context.request.get(`${BASE}/api/info`)).json();
    const addressCount = info.addresses?.length || 0;
    record('接口返回全部本机地址', addressCount >= 1,
      `${addressCount} 个：${(info.addresses || []).map(a => a.ip).join(', ')}`);

    if (addressCount > 1) {
      const selector = page.locator('#server-address');
      const selectorVisible = await waitVisible(selector, 5000);
      record('界面提供地址选择器', selectorVisible);

      if (selectorVisible) {
        const optionCount = await selector.locator('option').count();
        record('地址选择器选项完整', optionCount === addressCount, `${optionCount}/${addressCount}`);

        // 切换到非推荐地址，页面上展示的服务地址应跟随变化
        const target = info.addresses[1];
        await selector.selectOption(target.ip);
        const urlUpdated = await waitVisible(page.locator('.font-mono', { hasText: target.url }).first(), 5000);
        record('切换地址后服务地址跟随更新', urlUpdated, target.url);

        // 连接二维码也必须使用所选地址，否则手机扫了照样打不开
        await page.locator('button', { hasText: '显示连接二维码' }).click();
        const modalOpen = await waitVisible(page.locator('h3', { hasText: '扫码连接' }), 10000);
        const qrUrl = modalOpen
          ? ((await page.locator('.font-mono.text-accent').first().textContent()) || '').trim()
          : '';
        record('连接二维码跟随所选地址', qrUrl === target.url, `${qrUrl || '(未打开)'} (期望 ${target.url})`);
        await shot(page, '02-address-selected');
        await page.locator('button', { hasText: '关闭' }).click();

        // 还原为默认推荐地址，避免影响后续步骤
        await selector.selectOption(info.ip);
      }
    } else {
      record('单地址时无需选择器', await page.locator('#server-address').count() === 0, '仅一个地址');
    }

    // 3. 主题：默认白天，可切夜间并记住
    const themeNow = () => page.evaluate(() => document.documentElement.dataset.theme);
    const bodyBrightness = async () => {
      const bg = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
      const rgb = bg.match(/\d+/g);
      return rgb ? (Number(rgb[0]) * 299 + Number(rgb[1]) * 587 + Number(rgb[2]) * 114) / 1000 : null;
    };

    record('默认是白天主题', await themeNow() === 'light' && await bodyBrightness() > 128,
      `${await themeNow()} 亮度=${(await bodyBrightness()).toFixed(0)}`);

    await page.locator('.theme-toggle').click();
    await page.waitForTimeout(400);
    const darkBrightness = await bodyBrightness();
    record('可切换到夜间主题', await themeNow() === 'dark' && darkBrightness < 128,
      `${await themeNow()} 亮度=${darkBrightness.toFixed(0)}`);
    await shot(page, '03b-theme-dark');

    await page.reload();
    await page.waitForLoadState('networkidle');
    record('主题选择在刷新后保持', await themeNow() === 'dark');

    await page.locator('.theme-toggle').click();
    await page.waitForTimeout(300);
    record('可切回白天主题', await themeNow() === 'light');

    // 4. 上传进度与实时速度
    // 本机回环上传太快（几毫秒结束），用 CDP 限制上行带宽让进度可观测
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: -1,
      uploadThroughput: 1.5 * 1024 * 1024 // 1.5 MB/s
    });

    const uploadsDir = path.join(process.cwd(), 'uploads');
    const filesOnDiskBefore = fs.existsSync(uploadsDir)
      ? fs.readdirSync(uploadsDir).filter(name => !name.startsWith('.')).length
      : 0;

    const progressFileName = `验收-进度-${Date.now()}.bin`;
    await page.locator('input[type="file"]').setInputFiles({
      name: progressFileName,
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(6 * 1024 * 1024, 7) // 6MB
    });

    const progressLabel = page.locator('p', { hasText: '上传中...' });
    const progressVisible = await waitVisible(progressLabel, 15000);
    record('上传时显示进度百分比', progressVisible,
      progressVisible ? (await progressLabel.textContent()).trim() : '(未出现)');

    // 等出现「速度 + 剩余时间」这类实时数据
    let liveStats = '';
    for (let i = 0; i < 60; i++) {
      const stats = (await page.locator('.max-w-md .font-mono').first().textContent()) || '';
      if (/\/s/.test(stats) && /剩余/.test(stats)) {
        liveStats = stats.trim();
        break;
      }
      await page.waitForTimeout(250);
    }
    record('显示实时上传速度与剩余时间', liveStats.length > 0,
      liveStats || '(未出现速度/剩余时间)');

    const readBarWidth = () => page.evaluate(() => {
      const bar = document.querySelector('.max-w-md .bg-accent');
      return bar ? bar.getBoundingClientRect().width : 0;
    });

    const barBefore = await readBarWidth();
    await page.waitForTimeout(800);
    const barAfter = await readBarWidth();
    record('进度条随传输增长', barAfter > barBefore,
      `${barBefore.toFixed(0)}px → ${barAfter.toFixed(0)}px`);
    await shot(page, '03-upload-progress');

    // 取消上传：应回到待上传状态，且服务端不能残留半截文件
    await page.locator('button', { hasText: '取消上传' }).click();
    const backToIdle = await waitVisible(page.locator('button', { hasText: '选择文件' }), 10000);
    record('取消上传后回到待上传状态', backToIdle);

    await page.waitForTimeout(2000);
    const filesOnDiskAfter = fs.existsSync(uploadsDir)
      ? fs.readdirSync(uploadsDir).filter(name => !name.startsWith('.')).length
      : 0;
    record('取消后服务端未残留半截文件', filesOnDiskAfter <= filesOnDiskBefore,
      `磁盘文件数 ${filesOnDiskBefore} → ${filesOnDiskAfter}`);

    const cancelledInList = await page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: progressFileName }).count();
    record('被取消的文件未入库', cancelledInList === 0);

    // 恢复正常网络条件，避免影响后续步骤
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });

    // 5. 直接放进 uploads 目录的文件也会被列出 + 文件名搜索
    const dropToken = `验收放入${Date.now()}`;
    const searchTokenA = `验收搜A${Date.now()}`;
    const searchTokenB = `验收搜B${Date.now()}`;
    const droppedFiles = [
      `${dropToken}.txt`,
      `${searchTokenA}.txt`,
      `${searchTokenB}.txt`
    ];

    for (const name of droppedFiles) {
      fs.writeFileSync(path.join(uploadsDir, name), `dropped content: ${name}`);
    }

    // 服务端对上传目录的扫描有 5 秒节流，最多等 15 秒
    let listedDropped = [];
    for (let i = 0; i < 22; i++) {
      const listed = await (await context.request.get(`${BASE}/api/files`)).json();
      listedDropped = listed.filter(f => droppedFiles.includes(f.filename));
      if (listedDropped.length === droppedFiles.length) break;
      await page.waitForTimeout(700);
    }
    record('直接放进上传目录的文件会被列出', listedDropped.length === droppedFiles.length,
      `${listedDropped.length}/${droppedFiles.length}`);
    record('放入的文件识别出正确类型',
      listedDropped.length === droppedFiles.length && listedDropped.every(f => f.mime_type === 'text/plain'),
      listedDropped.map(f => f.mime_type).join(',') || '(无)');

    await page.reload();
    await page.waitForLoadState('networkidle');
    await shot(page, '04-dropped-files-listed');

    // 搜索：按文件名过滤
    const searchInput = page.locator('input[type="search"]');
    const searchVisible = await waitVisible(searchInput, 5000);
    record('界面提供搜索框', searchVisible);

    if (searchVisible) {
      await searchInput.fill(searchTokenA);
      const matchA = await waitVisible(
        page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: searchTokenA }).first(), 5000
      );
      const otherB = await page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: searchTokenB }).count();
      record('搜索按文件名过滤', matchA && otherB === 0,
        `命中A=${matchA} 同时出现B=${otherB}`);
      await shot(page, '05-search-filter');

      // 搜索框与「只看收藏」可叠加，且能一键清空
      await searchInput.fill('');
      const clearedA = await waitVisible(
        page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: searchTokenA }).first(), 5000
      );
      const clearedB = await waitVisible(
        page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: searchTokenB }).first(), 5000
      );
      record('清空搜索后恢复完整列表', clearedA && clearedB);

      await searchInput.fill('zzz-一定不存在-zzz');
      const noMatch = await waitVisible(page.locator('text=没有匹配的文件'), 5000);
      record('搜索无结果时给出提示', noMatch);
      await searchInput.fill('');
    }

    // 清理这几个放入的文件（删除会同时清掉磁盘文件）
    const allFiles = await (await context.request.get(`${BASE}/api/files`)).json();
    for (const name of droppedFiles) {
      const found = allFiles.find(f => f.filename === name);
      if (found) {
        await context.request.delete(`${BASE}/api/files/${found.id}`);
      }
    }
    const leftovers = fs.readdirSync(uploadsDir).filter(n => droppedFiles.includes(n));
    record('清理放入的测试文件', leftovers.length === 0, leftovers.join(',') || '已清理');

    // 6. 视频在线预览（真实解码播放）
    const sampleVideoPath = ensureSampleVideo();

    if (!sampleVideoPath) {
      recordSkipped('视频在线预览（真实播放）', '本机没有 ffmpeg 且 test_data/preview-sample.webm 不存在，无法生成样例视频');
    } else {
      // 文件名避免出现「预览」二字，否则会与「预览」按钮的文本撞车
      const previewName = `验收-样例视频-${Date.now()}.webm`;
      const previewUpload = await context.request.post(`${BASE}/api/upload`, {
        multipart: {
          files: { name: previewName, mimeType: 'video/webm', buffer: fs.readFileSync(sampleVideoPath) }
        }
      });
      const previewBody = await previewUpload.json();
      const previewId = previewBody.files[0].id;

      // 浏览器实际是否用 Range 拉流（视频拖动进度依赖它）
      const previewRangeHeaders = [];
      page.on('request', (request) => {
        if (request.url().includes(`/api/preview/${previewId}`)) {
          previewRangeHeaders.push(request.headers().range || '(无)');
        }
      });

      try {
        await page.reload();
        await page.waitForLoadState('networkidle');

        const card = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: previewName }).first();
        const cardVisible = await waitVisible(card, 10000);
        record('视频文件卡片出现预览按钮', cardVisible &&
          await card.locator('button', { hasText: '预览' }).count() > 0);

        await card.getByRole('button', { name: '预览', exact: true }).click();

        const modal = page.locator('div[role="dialog"][aria-label="文件预览"]');
        const modalOpen = await waitVisible(modal, 10000);
        record('预览弹窗打开', modalOpen);

        const videoVisible = await waitVisible(modal.locator('video'), 10000);
        record('弹窗内含 video 播放器', videoVisible);

        // 关键断言：不只是元素存在，而是真的解码并推进了时间轴
        const playback = videoVisible ? await page.evaluate(async () => {
          const video = document.querySelector('video');
          if (!video) return { error: 'no video' };

          const deadline = Date.now() + 12000;
          while (Date.now() < deadline) {
            if (video.readyState >= 3 && video.currentTime > 0.3) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }

          return {
            readyState: video.readyState,
            duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
            currentTime: Number(video.currentTime.toFixed(2)),
            width: video.videoWidth,
            height: video.videoHeight,
            paused: video.paused,
            error: video.error ? `${video.error.code}: ${video.error.message}` : null
          };
        }) : { error: '未找到 video 元素' };

        const played = !playback.error && playback.readyState >= 3 && playback.currentTime > 0.3;
        record('视频真的在播放（已解码并推进时间轴）', played,
          playback.error
            ? `错误：${playback.error}`
            : `readyState=${playback.readyState} 时长=${playback.duration}s 已播=${playback.currentTime}s 分辨率=${playback.width}x${playback.height} paused=${playback.paused}`);

        record('浏览器用 Range 拉流（支持拖动进度）',
          previewRangeHeaders.some(value => value.startsWith('bytes=')),
          previewRangeHeaders.join(' | ') || '(未观察到 Range 请求)');

        await shot(page, '08-video-preview');

        // 预览接口本身可独立访问（非流式场景）
        const direct = await context.request.get(`${BASE}/api/preview/${previewId}`);
        record('预览地址可直接访问且为内联', direct.status() === 200 &&
          (direct.headers()['content-disposition'] || '').includes('inline'),
          `HTTP ${direct.status()}`);

        // Esc 关闭
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        record('Esc 可关闭预览弹窗', await modal.count() === 0);
      } finally {
        await context.request.delete(`${BASE}/api/files/${previewId}`);
      }
    }

    // 7. 中文文件名上传（真实浏览器按 UTF-8 发送 multipart 文件名）
    await page.locator('input[type="file"]').setInputFiles(localFile);
    const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: CHINESE_NAME });
    await fileItem.first().waitFor({ state: 'visible', timeout: 15000 });
    record('中文文件名上传后保真显示', true, CHINESE_NAME);
    await shot(page, '02-uploaded');

    // 3. 收藏 → 刷新验证持久化 → 取消收藏
    const item = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: CHINESE_NAME }).first();
    const favBtn = item.locator('button').filter({ hasText: /收藏|星标/ }).first();

    const favResponse = page.waitForResponse(
      (r) => r.url().includes('/favorite') && r.request().method() === 'POST'
    );
    await favBtn.click();
    const favRes = await favResponse;
    const favJson = await favRes.json();
    record('收藏接口返回 200/success', favRes.status() === 200 && favJson.success === true,
      `status=${favRes.status()} is_favorite=${favJson.is_favorite}`);

    await page.waitForTimeout(400);
    const favClass = await page.locator('.bg-surface-3.rounded-2xl')
      .filter({ hasText: CHINESE_NAME }).first()
      .locator('button.is-favorite').count();
    record('收藏后按钮呈现已收藏状态', favClass > 0);
    await shot(page, '03-favorited');

    await page.reload();
    await page.waitForLoadState('networkidle');
    const persisted = await page.locator('.bg-surface-3.rounded-2xl')
      .filter({ hasText: CHINESE_NAME }).first()
      .locator('button.is-favorite').count();
    record('刷新后收藏状态持久化', persisted > 0);

    const unfavResponse = page.waitForResponse((r) => r.url().includes('/favorite'));
    await page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: CHINESE_NAME }).first()
      .locator('button').filter({ hasText: /收藏|星标/ }).first().click();
    const unfavRes = await unfavResponse;
    record('取消收藏接口 200', unfavRes.status() === 200);
    await page.waitForTimeout(300);

    // 4. 文件二维码
    await page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: CHINESE_NAME }).first()
      .locator('button', { hasText: '二维码' }).first().click();
    const qrModal = page.locator('h3', { hasText: '扫码下载' });
    await qrModal.waitFor({ state: 'visible', timeout: 10000 });
    const qrSvgCount = await page.locator('svg').count();
    record('文件二维码弹窗可打开', qrSvgCount > 0);
    await shot(page, '04-file-qrcode');

    const qrUrlText = await page.locator('.font-mono.break-all').first().textContent();
    record('二维码指向可下载地址', /^http:\/\/.+:13080\/download\/.+/.test((qrUrlText || '').trim()),
      (qrUrlText || '').trim());
    await page.locator('button', { hasText: '关闭' }).click();

    // 5. 下载并校验落地文件名（验证 Content-Disposition 的中文保真）
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
    await page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: CHINESE_NAME }).first()
      .locator('button', { hasText: '下载' }).first().click();
    const download = await downloadPromise;
    const suggested = download.suggestedFilename();
    record('下载文件名中文保真', suggested === CHINESE_NAME, `浏览器得到: ${suggested}`);
    const savedTo = path.join(SHOT_DIR, 'downloaded.txt');
    await download.saveAs(savedTo);
    const downloaded = fs.readFileSync(savedTo, 'utf8');
    record('下载内容与上传一致', downloaded === CHINESE_CONTENT);

    // 6. 扫码落地页（/download/:id）
    const idMatch = /\/download\/([^/?#]+)/.exec((qrUrlText || '').trim());
    if (idMatch) {
      const landing = await context.newPage();
      await landing.goto(`/download/${idMatch[1]}`);
      await landing.waitForLoadState('domcontentloaded');
      const h1 = await landing.locator('h1').first().textContent();
      record('扫码落地页显示文件名', (h1 || '').includes(CHINESE_NAME), h1 || '(空)');
      await shot(landing, '05-download-landing');
      await landing.close();
    }

    // 7. 删除文件（自动接受确认框）
    page.on('dialog', (d) => d.accept());
    await page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: CHINESE_NAME }).first()
      .locator('button', { hasText: '删除' }).click();
    await page.waitForTimeout(1200);
    const remaining = await page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: CHINESE_NAME }).count();
    record('删除后列表不再出现该文件', remaining === 0);
    await shot(page, '06-deleted');

    // 8. 管理后台
    // 后台列表需要至少一条数据才能验证「真的渲染出行」，这里自建一条（脚本不依赖历史数据）
    const adminProbeName = `验收-后台列表-${Date.now()}.txt`;
    const probeUpload = await context.request.post(`${BASE}/api/upload`, {
      multipart: {
        files: { name: adminProbeName, mimeType: 'text/plain', buffer: Buffer.from('admin probe') }
      }
    });
    const probeBody = await probeUpload.json();
    const probeId = probeBody.files[0].id;

    const adminPage = await context.newPage();
    await adminPage.goto(ADMIN);
    await adminPage.waitForLoadState('networkidle');
    await adminPage.waitForTimeout(1200);
    const adminTitle = await adminPage.title();
    record('管理后台标题正确', adminTitle.includes('管理后台'), adminTitle);
    const fileCount = (await adminPage.locator('#fileCount').textContent())?.trim();
    const totalSize = (await adminPage.locator('#totalSize').textContent())?.trim();
    const port = (await adminPage.locator('#serverPort').textContent())?.trim();
    record('后台状态卡片有真实数据', fileCount !== '-' && totalSize !== '-' && port === '13080',
      `文件总数=${fileCount} 总大小=${totalSize} 端口=${port}`);
    const fileRows = await adminPage.locator('.file-item').count();
    record('后台文件列表渲染', fileRows > 0, `${fileRows} 行`);
    const probeRowVisible = await adminPage.locator('.file-item').filter({ hasText: adminProbeName }).count();
    record('后台列表包含刚上传的文件', probeRowVisible > 0, adminProbeName);

    const adminStatus = await adminPage.evaluate(async () =>
      (await fetch('/api/admin/status')).json()
    );
    record('后台 status 接口为扁平结构', typeof adminStatus.fileCount === 'number' &&
      typeof adminStatus.diskUsage === 'number' && typeof adminStatus.serverPort === 'number',
      JSON.stringify({ fileCount: adminStatus.fileCount, serverPort: adminStatus.serverPort }));

    const adminFiles = await adminPage.evaluate(async () => (await fetch('/api/admin/files')).json());
    record('后台 files 接口返回数组', Array.isArray(adminFiles), Array.isArray(adminFiles) ? `长度 ${adminFiles.length}` : typeof adminFiles);
    await shot(adminPage, '07-admin');
    await adminPage.close();

    // 清理探针文件
    await context.request.delete(`${BASE}/api/files/${probeId}`);

    record('页面无 JavaScript 运行时错误', pageErrors.length === 0, pageErrors.join(' | ') || '无');
  } finally {
    await browser.close();
    if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`验收结果：${results.length - failures}/${results.length} 通过` +
    (skipped.length ? `，${skipped.length} 项跳过` : ''));
  if (skipped.length) {
    skipped.forEach(item => console.log(`   跳过：${item.name}（${item.reason}）`));
  }
  console.log(`截图目录：${SHOT_DIR}`);
  console.log('='.repeat(60));

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本异常终止:', err);
  process.exit(2);
});
