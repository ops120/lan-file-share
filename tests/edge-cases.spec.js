import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_FILES_DIR = path.join(__dirname, '..', 'test_data', 'edge_cases');

// 端口不硬编码：端口以 config.json 为准（Express 同时托管前端与 API）
const { port: SERVER_PORT } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8')
);
const BASE_URL = `http://localhost:${SERVER_PORT}`;

// 真实 DOM：文件卡片为 div.bg-surface-3.rounded-2xl（服务信息卡片是 rounded-3xl，不会误匹配）
const FILE_CARD = '.bg-surface-3.rounded-2xl';

// 每次运行使用唯一文件名后缀，避免多次运行后同名文件堆积
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
function uniqueName(base, ext = '.txt') {
  return `${base}_${RUN_TAG}_${++seq}${ext}`;
}

// 辅助函数：创建测试文件
function createTestFile(filename, sizeInBytes) {
  const filePath = path.join(TEST_FILES_DIR, filename);

  if (sizeInBytes === 0) {
    fs.writeFileSync(filePath, '');
  } else {
    const buffer = Buffer.alloc(sizeInBytes);
    const header = `Test: ${filename}\n`;
    buffer.write(header, 0);
    fs.writeFileSync(filePath, buffer);
  }

  return filePath;
}

// 辅助函数：定位包含指定文件名的文件卡片
function fileCard(page, filename) {
  return page.locator(FILE_CARD).filter({ hasText: filename });
}

// 辅助函数：等待文件出现在列表中（web-first，轮询到可见为止）
async function waitForFileInList(page, filename, timeout = 10000) {
  await expect(fileCard(page, filename)).toBeVisible({ timeout });
}

// 辅助函数：获取文件列表数量
async function getFileCount(page) {
  const items = await page.locator(FILE_CARD).count();
  return items;
}

// 辅助函数：等待一次 POST /api/upload 响应（用于替代裸 waitForTimeout）
function waitForUploadResponse(page, timeout = 60000) {
  return page.waitForResponse(
    r => r.url().includes('/api/upload') && r.request().method() === 'POST',
    { timeout }
  );
}

test.describe('边界情况测试', () => {

  test.beforeAll(() => {
    if (!fs.existsSync(TEST_FILES_DIR)) {
      fs.mkdirSync(TEST_FILES_DIR, { recursive: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole('heading', { level: 1, name: '本地文件交互系统' })).toBeVisible();
  });

  test.afterAll(() => {
    if (fs.existsSync(TEST_FILES_DIR)) {
      fs.rmSync(TEST_FILES_DIR, { recursive: true, force: true });
    }
  });

  test('上传空文件（0字节）', async ({ page }) => {
    const filename = uniqueName('empty-file');
    const emptyFile = createTestFile(filename, 0);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(emptyFile);

    await waitForFileInList(page, filename);

    const card = fileCard(page, filename);
    await expect(card).toBeVisible();

    const sizeText = card.locator('text=/^0(\\.0)? B ·/');
    await expect(sizeText).toBeVisible();
  });

  test('上传超大文件（接近限制）', async ({ page }) => {
    test.setTimeout(120000);

    const filename = uniqueName('large-file', '.bin');
    const largeSize = 100 * 1024 * 1024;
    const largeFile = createTestFile(filename, largeSize);

    const fileInput = page.locator('input[type="file"]');

    const uploadResponse = waitForUploadResponse(page, 100000);
    await fileInput.setInputFiles(largeFile);

    // 若捕获到上传进度提示，则等待其消失；随后必须以真实的上传响应收口（不再盲等）
    const progressIndicator = page.locator('text=/上传中|Uploading|进度/i').first();
    if (await progressIndicator.isVisible()) {
      await expect(progressIndicator).toBeHidden({ timeout: 100000 });
    }

    await uploadResponse;

    await waitForFileInList(page, filename, 60000);

    const card = fileCard(page, filename);
    await expect(card).toBeVisible();

    const sizeText = card.locator('text=/100(\\.0)? MB/');
    await expect(sizeText).toBeVisible();
  });

  test('上传特殊字符文件名', async ({ page }) => {
    const specialNames = [
      'test文件中文',
      'test-file@#$%',
      'test file spaces',
      'test_under-score',
      'тест-русский',
      '测试-日本語-한국어'
    ];

    for (const base of specialNames) {
      // 保留特殊字符，仅追加唯一后缀，保证可重复运行
      const filename = uniqueName(base, '.txt');
      const filePath = createTestFile(filename, 1024);

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(filePath);

      await waitForFileInList(page, filename);
      await expect(fileCard(page, filename)).toBeVisible();
    }
  });

  test('并发上传多个文件', async ({ page }) => {
    test.setTimeout(60000);

    const concurrentFiles = [];
    const concurrentNames = [];
    for (let i = 1; i <= 10; i++) {
      const filename = uniqueName(`concurrent-${i}`);
      concurrentNames.push(filename);
      concurrentFiles.push(createTestFile(filename, 5 * 1024 * 1024));
    }

    const fileInput = page.locator('input[type="file"]');

    const uploadResponse = waitForUploadResponse(page);
    await fileInput.setInputFiles(concurrentFiles);
    await uploadResponse;

    for (const filename of concurrentNames) {
      await waitForFileInList(page, filename, 30000);
    }

    for (const filename of concurrentNames) {
      await expect(fileCard(page, filename)).toBeVisible();
    }
  });

  test('网络延迟情况（模拟慢速网络）', async ({ page }) => {
    test.setTimeout(90000);

    await page.route('**/api/upload', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 5000));
      await route.continue();
    });

    const filename = uniqueName('slow-network');
    const slowFile = createTestFile(filename, 1024);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(slowFile);

    // 上传期间应显示“上传中...”（store 中 uploading=true 时 App 渲染该文案）
    await expect(page.locator('text=/上传中|Uploading/i').first()).toBeVisible({ timeout: 10000 });

    // 慢速请求（延迟 5s）完成后文件才会入列，web-first 等待覆盖该窗口，无需盲等
    await waitForFileInList(page, filename, 30000);
    await expect(fileCard(page, filename)).toBeVisible();
  });

  test('服务器错误情况（500错误）', async ({ page }) => {
    // 文件名刻意不含 错误/失败/error 等字样，避免错误提示定位器自匹配文件名
    const filename = uniqueName('server-500');

    await page.route('**/api/upload', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal Server Error' })
      });
    });

    const errorFile = createTestFile(filename, 1024);

    const fileInput = page.locator('input[type="file"]');

    const errorResponse = page.waitForResponse(
      r => r.url().includes('/api/upload') && r.request().method() === 'POST'
    );
    await fileInput.setInputFiles(errorFile);
    await errorResponse;

    const errorMessage = page.locator('text=/错误|失败|Error|Failed/i').first();
    const fileNotInList = fileCard(page, filename);

    const hasError = await errorMessage.isVisible().catch(() => false);
    const fileVisible = await fileNotInList.isVisible().catch(() => false);

    expect(hasError || !fileVisible).toBeTruthy();
  });

  test('文件不存在情况（404错误）', async ({ page }) => {
    await page.route('**/api/download/nonexistent123', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'File not found' })
      });
    });

    const response = await page.request.get(`${BASE_URL}/api/download/nonexistent123`);
    expect(response.status()).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toContain('not found');
  });

  test('过期文件自动清理（修改时间测试）', async ({ page }) => {
    test.setTimeout(30000);

    const filename = uniqueName('expire-test');
    const testFile = createTestFile(filename, 1024);

    const fileInput = page.locator('input[type="file"]');

    const uploadResponse = waitForUploadResponse(page);
    await fileInput.setInputFiles(testFile);
    await uploadResponse;

    await waitForFileInList(page, filename);

    const initialCount = await getFileCount(page);
    expect(initialCount).toBeGreaterThanOrEqual(1);

    const response = await page.request.get(`${BASE_URL}/api/files`);
    const files = await response.json();
    const uploadedFile = files.find(f => f.filename === filename);

    expect(uploadedFile).toBeDefined();
    expect(uploadedFile).toHaveProperty('expire_time');
    expect(uploadedFile.expire_time).toBeGreaterThan(Date.now());

    const timeUntilExpiry = uploadedFile.expire_time - uploadedFile.upload_time;
    expect(timeUntilExpiry).toBeGreaterThan(0);
    expect(timeUntilExpiry).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  test('上传重复文件名', async ({ page }) => {
    const filename = uniqueName('duplicate');
    const duplicateFile = createTestFile(filename, 2048);

    const fileInput = page.locator('input[type="file"]');

    const uploadResponse = waitForUploadResponse(page);
    await fileInput.setInputFiles(duplicateFile);
    await uploadResponse;

    await waitForFileInList(page, filename);
    const countAfterFirst = await fileCard(page, filename).count();

    const uploadResponse2 = waitForUploadResponse(page);
    await fileInput.setInputFiles(duplicateFile);
    await uploadResponse2;

    // 真实实现：同名文件独立存在（不是覆盖），第二次上传后应出现两条卡片
    await expect(fileCard(page, filename)).toHaveCount(2);

    const countAfterSecond = await fileCard(page, filename).count();

    expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
  });

  test('上传中取消操作（断开连接）', async ({ page }) => {
    test.setTimeout(30000);

    let requestIntercepted = false;

    await page.route('**/api/upload', async (route) => {
      requestIntercepted = true;
      await new Promise(resolve => setTimeout(resolve, 10000));
      try {
        await route.continue();
      } catch {
        // 页面已重载导致请求被中止，属于本用例预期的“取消”行为
      }
    });

    const filename = uniqueName('cancel-test');
    const cancelFile = createTestFile(filename, 5 * 1024 * 1024);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(cancelFile);

    // 上传必须已真实发起并处于上传中状态
    await expect(page.locator('text=/上传中|Uploading/i').first()).toBeVisible({ timeout: 5000 });

    // 重载页面即中止在途上传请求（模拟断开连接）
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: '本地文件交互系统' })).toBeVisible();

    expect(requestIntercepted).toBe(true);
  });

  test('断点续传功能测试', async ({ page }) => {
    test.setTimeout(60000);

    // 说明：前端上传只走 POST /api/upload，并未调用分块接口（真实差距，已另行上报）。
    // 这里按真实实现直接驱动后端断点续传接口：分块上传 -> 失败重试 -> 状态查询续传 -> 合并落盘。
    const chunkName = `resume-chunks_${RUN_TAG}.bin`;      // 分块临时文件名（纯文件名）
    const displayName = `resume-result_${RUN_TAG}.bin`;    // 合并后的展示文件名
    const octetStream = { 'Content-Type': 'application/octet-stream' };
    const chunks = [
      Buffer.alloc(64 * 1024, 'a'),
      Buffer.alloc(64 * 1024, 'b'),
      Buffer.alloc(1024, 'c'),
    ];
    const chunkUrl = (params) => {
      const qs = new URLSearchParams({
        filename: chunkName,
        totalChunks: String(chunks.length),
        originalName: displayName,
        mimeType: 'application/octet-stream',
        ...params,
      });
      return `${BASE_URL}/api/upload/chunk?${qs}`;
    };

    // 模拟第 0 块首次上传失败（空 body 会被后端以 400 拒绝），随后断点重试成功
    const failedAttempt = await page.request.post(
      chunkUrl({ chunkIndex: '0' }), { data: Buffer.alloc(0), headers: octetStream });
    expect(failedAttempt.status()).toBe(400);

    const firstChunk = await page.request.post(
      chunkUrl({ chunkIndex: '0' }), { data: chunks[0], headers: octetStream });
    expect(firstChunk.ok()).toBe(true);

    // 续传核心：状态查询应如实报告“仅第 0 块已上传”，供客户端跳过续传
    const status = await (await page.request.get(`${BASE_URL}/api/upload/status/${chunkName}`)).json();
    expect(status.uploaded).toBe(false);
    expect(status.uploadedChunks).toEqual([0]);
    expect(status.totalSize).toBe(chunks[0].length);

    // 从断点继续上传剩余分块，最后一块触发合并
    let lastResponse = null;
    for (let i = 1; i < chunks.length; i++) {
      lastResponse = await page.request.post(
        chunkUrl({ chunkIndex: String(i) }), { data: chunks[i], headers: octetStream });
      expect(lastResponse.ok()).toBe(true);
    }

    const finalData = await lastResponse.json();
    expect(finalData.success).toBe(true);
    expect(finalData.message).toBe('文件上传完成');
    expect(finalData.files).toHaveLength(1);
    expect(finalData.files[0].filename).toBe(displayName);

    // 合并后的文件真实入库且字节数与各分块之和一致
    const files = await (await page.request.get(`${BASE_URL}/api/files`)).json();
    const uploaded = files.filter(f => f.filename === displayName);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].size).toBe(chunks.reduce((sum, c) => sum + c.length, 0));

    // 安全行为：filename 含路径分隔符的分块请求必须被 400 拒绝（防路径穿越）
    const traversal = await page.request.post(
      chunkUrl({ chunkIndex: '0', filename: `../evil_${RUN_TAG}.bin` }),
      { data: chunks[0], headers: octetStream });
    expect(traversal.status()).toBe(400);
  });

  test('文件类型验证（危险文件扩展名）', async ({ page }) => {
    const dangerousExtensions = ['.exe', '.bat', '.sh', '.cmd'];

    for (const ext of dangerousExtensions) {
      const filename = uniqueName('dangerous', ext);
      const filePath = createTestFile(filename, 1024);

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(filePath);

      // 后端与前端均不过滤危险扩展名：文件应能上传并显示在列表中
      await waitForFileInList(page, filename);
      await expect(fileCard(page, filename)).toBeVisible();
    }
  });

  test('大量文件列表加载性能', async ({ page }) => {
    test.setTimeout(120000);

    const manyFiles = [];
    for (let i = 1; i <= 50; i++) {
      manyFiles.push(createTestFile(uniqueName(`perf-test-${i}`), 1024));
    }

    const fileInput = page.locator('input[type="file"]');

    const uploadResponse = waitForUploadResponse(page);
    await fileInput.setInputFiles(manyFiles);
    await uploadResponse;

    // 等待列表刷新（上传响应后前端会 fetchFiles 一次性写入全部文件）
    // 过滤条件带上本次运行的 RUN_TAG，避免与历史运行的同名前缀卡片产生 strict 冲突
    await expect(
      page.locator(FILE_CARD).filter({ hasText: `perf-test-1_${RUN_TAG}` })
    ).toBeVisible({ timeout: 30000 });

    const startTime = Date.now();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: '本地文件交互系统' })).toBeVisible();
    const loadTime = Date.now() - startTime;

    expect(loadTime).toBeLessThan(10000);

    // 列表是 reload 之后异步拉取的，紧接着 count 会读到 0（竞态），这里轮询等它真正渲染出来
    await expect
      .poll(() => getFileCount(page), { timeout: 30000, message: '刷新后文件列表应渲染出全部文件' })
      .toBeGreaterThanOrEqual(50);
  });

  test('WebSocket连接断开重连', async ({ page }) => {
    test.setTimeout(30000);

    // 真实实现里 WS 实例保存在 zustand store，页面无法直接访问 window.ws，
    // 用 Playwright 的 routeWebSocket 直接掐断升级握手来模拟断开（store 的 onclose 会重连）
    let closedConnections = 0;
    await page.routeWebSocket(/^wss?:\/\//, (route) => {
      closedConnections++;
      route.close();
    });

    // 重新加载页面触发新的 WS 连接（此时会被拦截并立即断开）
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: '本地文件交互系统' })).toBeVisible();
    await expect.poll(() => closedConnections, { timeout: 10000 }).toBeGreaterThan(0);

    // WS 不可用时上传依然要成功（列表是上传成功后 fetchFiles 刷新，不依赖 WS）
    const filename = uniqueName('ws-reconnect');
    const testFile = createTestFile(filename, 1024);
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFile);

    await waitForFileInList(page, filename, 15000);
    await expect(fileCard(page, filename)).toBeVisible();
  });

  test('内存泄漏检测（重复操作）', async ({ page }) => {
    test.setTimeout(60000);

    for (let i = 0; i < 10; i++) {
      const tempFile = createTestFile(uniqueName(`memory-test-${i}`), 10 * 1024);

      const fileInput = page.locator('input[type="file"]');

      const uploadResponse = waitForUploadResponse(page);
      await fileInput.setInputFiles(tempFile);
      await uploadResponse;

      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: '本地文件交互系统' })).toBeVisible();
    }

    const metrics = await page.evaluate(() => {
      if (performance.memory) {
        return {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        };
      }
      return null;
    });

    if (metrics) {
      const heapUsagePercent = (metrics.usedJSHeapSize / metrics.jsHeapSizeLimit) * 100;
      expect(heapUsagePercent).toBeLessThan(90);
    }
  });
});
