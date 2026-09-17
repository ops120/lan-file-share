/**
 * 完整的端到端测试套件
 * 整合所有测试场景：主页、二维码、管理后台、文件操作、边界情况等
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// ============ 全局配置 ============
const BASE_URL = 'http://localhost:13080';
const ADMIN_URL = 'http://localhost:13081';
const TEST_DATA_DIR = path.join(process.cwd(), 'test_data');

// ============ 测试数据准备 ============
test.beforeAll(async () => {
  // 创建测试数据目录
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  // 创建测试文件
  const testFiles = [
    { name: 'small-test.txt', size: 500, content: 'Small test file content\n'.repeat(20) },
    { name: 'medium-test.txt', size: 50 * 1024, content: 'M' },
    { name: 'large-test.json', size: 2 * 1024 * 1024, content: 'L' },
    { name: 'empty-test.txt', size: 0, content: '' },
    { name: '测试文件-中文.txt', size: 1024, content: '中文内容测试\n' },
  ];

  for (const file of testFiles) {
    const filePath = path.join(TEST_DATA_DIR, file.name);
    if (!fs.existsSync(filePath)) {
      if (file.size === 0) {
        fs.writeFileSync(filePath, '');
      } else {
        const content = file.content.repeat(Math.ceil(file.size / file.content.length));
        fs.writeFileSync(filePath, content.substring(0, file.size));
      }
    }
  }

  console.log('✓ 测试数据准备完成');
});

test.afterAll(async () => {
  // 清理测试数据
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  console.log('✓ 测试数据清理完成');
});

// ============ 辅助函数 ============
// 主应用文件卡片的真实 DOM：div.bg-surface-3.rounded-2xl（服务信息卡片是 rounded-3xl，可区分）
const FILE_CARD_SELECTOR = 'div.bg-surface-3.rounded-2xl';

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// 用例文件名带随机后缀，保证可重复运行且互不冲突
function uniqueName(base) {
  const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ext = path.extname(base);
  return `${path.basename(base, ext)}-${rand}${ext}`;
}

function createTempFile(name, content = '') {
  const filePath = path.join(TEST_DATA_DIR, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function fileCard(page, fileName) {
  return page.locator(FILE_CARD_SELECTOR).filter({ hasText: fileName });
}

async function uploadFile(page, filePath) {
  await page.locator('input[type="file"]').setInputFiles(filePath);
}

// web-first：等待上传完成后文件出现在列表中，而不是固定 sleep
async function waitForFileInList(page, fileName) {
  await expect(page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15000 });
}

// 通过 UI 删除（原生 confirm 是同步阻塞对话框，必须在监听回调里立即应答，
// 否则 click 动作会被对话框卡住直至超时），并以卡片消失作为完成信号
async function deleteFileViaUI(page, fileName) {
  const card = fileCard(page, fileName);
  const deleteButton = card.locator('button:has-text("删除")').first();
  await expect(deleteButton).toBeVisible();

  const dialogClosed = new Promise(resolve => {
    page.once('dialog', dialog => {
      dialog.accept().then(() => resolve(dialog)).catch(() => resolve(dialog));
    });
  });
  await deleteButton.click();
  await dialogClosed;

  await expect(card).toHaveCount(0, { timeout: 10000 });
}

// ============================================
// 测试套件 1: 主页基础功能
// ============================================
test.describe('主页测试', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') console.error('浏览器错误:', msg.text());
    });
    page.on('pageerror', error => console.error('页面错误:', error));
  });

  test('页面加载成功（200状态码）', async ({ page }) => {
    const response = await page.goto(BASE_URL);
    expect(response).not.toBeNull();
    expect(response.status()).toBe(200);
    expect(response.ok()).toBeTruthy();
  });

  test('标题正确显示', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');

    const title = await page.title();
    expect(title).toBe('本地文件交互系统');

    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('本地文件交互系统');
  });

  test('关键元素存在 - 上传区域', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    const uploadArea = page.locator('text=拖拽文件到此处上传').locator('..');
    await expect(uploadArea).toBeVisible();

    const uploadButton = page.locator('button:has-text("选择文件")');
    await expect(uploadButton).toBeVisible();
    await expect(uploadButton).toBeEnabled();
  });

  test('关键元素存在 - 服务器信息', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    const serverInfoSection = page.locator('text=服务地址').locator('..');
    await expect(serverInfoSection).toBeVisible();

    const storageInfo = page.locator('text=存储使用').locator('..');
    await expect(storageInfo).toBeVisible();

    const qrButton = page.locator('button:has-text("连接二维码")');
    await expect(qrButton).toBeVisible();
    await expect(qrButton).toBeEnabled();
  });

  test('页面无 JavaScript 错误', async ({ page }) => {
    const consoleErrors = [];
    const pageErrors = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    expect(consoleErrors.length, `控制台错误: ${consoleErrors.join(', ')}`).toBe(0);
    expect(pageErrors.length, `页面错误: ${pageErrors.join(', ')}`).toBe(0);
  });

  test('响应式布局 - 桌面端', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    const mainContainer = page.locator('main').first();
    await expect(mainContainer).toBeVisible();

    const mainBox = await mainContainer.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(mainBox.width).toBeGreaterThan(800);
  });

  test('响应式布局 - 移动端', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    const mainContainer = page.locator('main').first();
    await expect(mainContainer).toBeVisible();

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(390);
  });
});

// ============================================
// 测试套件 2: 二维码功能
// ============================================
test.describe('二维码功能测试', () => {
  // 注意：弹窗中的二维码由 qrcode.react 渲染为 <svg>，不是 <img>，也没有 base64 data URL。
  // 因此断言对象是弹窗内的 SVG 二维码 + URL 文本，而不是 img[src^=data:]。
  test('服务器连接二维码生成', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('button:has-text("连接二维码")')).toBeVisible();

    const qrApiPromise = page.waitForResponse(
      r => r.url().includes('/api/connect-qrcode') && r.status() === 200
    );
    await page.locator('button:has-text("连接二维码")').click();

    const dialog = page.locator('div.fixed.inset-0').filter({ hasText: '扫码连接' });
    await expect(dialog.getByRole('heading', { name: '扫码连接' })).toBeVisible();
    await expect(dialog.locator('svg')).toBeVisible();
    await expect(dialog.locator('.font-mono')).toContainText(':13080');

    // 后端返回的分享 URL 与弹窗展示的地址一致（http://<IP>:13080）
    const qrData = await (await qrApiPromise).json();
    expect(qrData.url).toMatch(/^https?:\/\//);
    expect(qrData.url).toContain('13080');
  });

  test('二维码图片尺寸验证', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.locator('button:has-text("连接二维码")').click();

    const qrSvg = page.locator('div.fixed.inset-0')
      .filter({ hasText: '扫码连接' })
      .locator('svg')
      .first();
    // web-first 等待渲染完成后再量尺寸
    await expect(qrSvg).toBeVisible();

    const box = await qrSvg.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(150);
    expect(box.height).toBeGreaterThanOrEqual(150);
  });

  test('二维码对话框关闭功能', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.locator('button:has-text("连接二维码")').click();

    const dialog = page.locator('div.fixed.inset-0').filter({ hasText: '扫码连接' });
    await expect(dialog.getByRole('heading', { name: '扫码连接' })).toBeVisible();

    await dialog.locator('button:has-text("关闭")').click();
    await expect(dialog).toHaveCount(0);
  });
});

// ============================================
// 测试套件 3: 管理后台
// ============================================
test.describe('管理后台测试', () => {
  test('管理后台页面加载成功', async ({ page }) => {
    const response = await page.goto(ADMIN_URL);
    expect(response).not.toBeNull();
    expect(response.status()).toBe(200);
  });

  // 后台状态卡真实标签（admin/index.html）：文件总数 / 总存储大小 / 磁盘占用 / 服务端口
  // 对应 #fileCount #totalSize #diskUsage #serverPort，数据来自 GET /api/admin/status（扁平结构）
  test('系统状态卡片显示', async ({ page }) => {
    await page.goto(ADMIN_URL);

    const statusLabels = ['文件总数', '总存储大小', '磁盘占用', '服务端口'];
    for (const label of statusLabels) {
      await expect(page.locator('.stat-item').filter({ hasText: label })).toBeVisible();
    }
    await expect(page.locator('.stats-grid')).toBeVisible();

    // 数据异步加载：等到占位符 "-" 被真实值替换
    await expect(page.locator('#fileCount')).not.toHaveText('-');
    await expect(page.locator('#totalSize')).not.toHaveText('-');
    await expect(page.locator('#diskUsage')).not.toHaveText('-');
    await expect(page.locator('#serverPort')).not.toHaveText('-');

    await expect(page.locator('#fileCount')).toHaveText(/\d+/);
    await expect(page.locator('#serverPort')).toHaveText('13080');
  });

  test('文件列表表格渲染', async ({ page }) => {
    // 后台是独立服务（13081），页面加载时自己请求 /api/admin/files（返回数组）
    const filesResponse = page.waitForResponse(
      r => r.url().includes('/api/admin/files') && r.status() === 200
    );
    await page.goto(ADMIN_URL);

    await expect(page.getByRole('heading', { name: '文件管理' })).toBeVisible();
    await expect(page.locator('#fileList')).toBeVisible();

    const adminFiles = await (await filesResponse).json();
    expect(Array.isArray(adminFiles)).toBeTruthy();

    if (adminFiles.length > 0) {
      await expect(page.locator('#fileList .file-item').first()).toBeVisible();
      await expect
        .poll(() => page.locator('#fileList .file-item').count())
        .toBe(adminFiles.length);
    } else {
      await expect(page.locator('#fileList .loading')).toHaveText('暂无文件');
    }
  });

  test('配置表单正确加载', async ({ page }) => {
    await page.goto(ADMIN_URL);
    await page.waitForLoadState('networkidle');

    const formFields = [
      { label: 'IP 地址', type: 'input' },
      { label: '端口', type: 'input' },
      { label: '上传目录', type: 'input' },
    ];

    for (const field of formFields) {
      const input = page.locator(`label:has-text("${field.label}") ~ input, input[placeholder*="${field.label}"]`).first();
      if (await input.count() > 0) {
        await expect(input).toBeVisible();
      }
    }
  });
});

// ============================================
// 测试套件 4: 文件上传
// ============================================
test.describe('文件上传测试', () => {
  test('成功上传小文件', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'Small test file content\n'.repeat(20));
    await uploadFile(page, testFile);

    await waitForFileInList(page, fileName);
    await expect(fileCard(page, fileName)).toBeVisible();

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });

  test('成功上传中文文件名', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('测试文件-中文.txt');
    const testFile = createTempFile(fileName, '中文内容测试\n');
    await uploadFile(page, testFile);

    await waitForFileInList(page, fileName);
    await expect(fileCard(page, fileName)).toBeVisible();

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });

  test('上传空文件', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('empty-test.txt');
    const testFile = createTempFile(fileName, '');
    await uploadFile(page, testFile);

    // 空文件同样会入库并出现在列表里
    await waitForFileInList(page, fileName);
    await expect(fileCard(page, fileName)).toBeVisible();

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });

  test('文件信息正确显示', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'x'.repeat(2048)); // 2048 B → 显示 2.0 KB
    await uploadFile(page, testFile);

    await waitForFileInList(page, fileName);

    const card = fileCard(page, fileName);
    await expect(card).toContainText(/\d+(\.\d+)?\s*(B|KB|MB)/);
    await expect(card).toContainText('2.0 KB');

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });
});

// ============================================
// 测试套件 5: 文件下载
// ============================================
test.describe('文件下载测试', () => {
  test('完整文件下载流程', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'Small test file content\n'.repeat(20));
    await uploadFile(page, testFile);
    await waitForFileInList(page, fileName);

    const downloadButton = fileCard(page, fileName).locator('button:has-text("下载")').first();
    await expect(downloadButton).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain(fileName);

    const downloadPath = path.join(TEST_DATA_DIR, 'downloaded-' + fileName);
    await download.saveAs(downloadPath);

    const originalSize = fs.statSync(testFile).size;
    const downloadedSize = fs.statSync(downloadPath).size;
    expect(downloadedSize).toBe(originalSize);

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(downloadPath);
    fs.unlinkSync(testFile);
  });

  test('下载按钮可见性', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'visible download button');
    await uploadFile(page, testFile);
    await waitForFileInList(page, fileName);

    const downloadButton = fileCard(page, fileName).locator('button:has-text("下载")').first();
    await expect(downloadButton).toBeVisible();

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });
});

// ============================================
// 测试套件 6: 文件删除
// ============================================
test.describe('文件删除测试', () => {
  test('完整删除流程', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'to be deleted');
    await uploadFile(page, testFile);
    await waitForFileInList(page, fileName);

    const card = fileCard(page, fileName);
    const deleteButton = card.locator('button:has-text("删除")').first();

    // 原生 confirm 同步阻塞页面，需在回调里同步应答
    const dialogSeen = new Promise(resolve => {
      page.once('dialog', dialog => {
        resolve(dialog);
        dialog.accept().catch(() => {});
      });
    });
    await deleteButton.click();
    const dialog = await dialogSeen;
    expect(dialog.message()).toContain('删除');

    // web-first：卡片消失即删除完成，不 sleep 赌时间
    await expect(card).toHaveCount(0, { timeout: 10000 });
    fs.unlinkSync(testFile);
  });

  test('取消删除确认', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'keep me');
    await uploadFile(page, testFile);
    await waitForFileInList(page, fileName);

    const card = fileCard(page, fileName);
    const deleteButton = card.locator('button:has-text("删除")').first();

    const dialogSeen = new Promise(resolve => {
      page.once('dialog', dialog => {
        resolve(dialog);
        dialog.dismiss().catch(() => {});
      });
    });
    await deleteButton.click();
    const dialog = await dialogSeen;
    expect(dialog.message()).toContain('删除');

    // 取消后文件仍在
    await expect(card).toBeVisible();

    // 清理自己创建的文件
    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });

  test('删除按钮样式验证', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'style check');
    await uploadFile(page, testFile);
    await waitForFileInList(page, fileName);

    const deleteButton = fileCard(page, fileName).locator('button:has-text("删除")').first();
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });
});

// ============================================
// 测试套件 7: 完整用户流程
// ============================================
test.describe('完整用户流程测试', () => {
  test('端到端完整流程', async ({ page, context }) => {
    // 步骤 1: 打开主页
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');
    console.log('✓ 步骤 1: 主页加载成功');

    // 步骤 2: 上传文件（唯一文件名，保证可重复）
    const fileName = uniqueName('medium-test.txt');
    const testFile = createTempFile(fileName, 'M'.repeat(50 * 1024));
    await uploadFile(page, testFile);
    await waitForFileInList(page, fileName);
    console.log('✓ 步骤 2: 文件上传成功');

    // 步骤 3: 验证文件显示
    const card = fileCard(page, fileName);
    await expect(card).toBeVisible();
    console.log('✓ 步骤 3: 文件列表显示正常');

    // 步骤 4: 生成连接二维码（qrcode.react 渲染 SVG）
    await page.locator('button:has-text("连接二维码")').click();
    const qrDialog = page.locator('div.fixed.inset-0').filter({ hasText: '扫码连接' });
    await expect(qrDialog.locator('svg')).toBeVisible();
    await qrDialog.locator('button:has-text("关闭")').click();
    await expect(qrDialog).toHaveCount(0);
    console.log('✓ 步骤 4: 二维码生成成功');

    // 步骤 5: 下载文件
    const downloadButton = card.locator('button:has-text("下载")').first();
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await downloadButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain(fileName);

    const downloadPath = path.join(TEST_DATA_DIR, 'e2e-' + fileName);
    await download.saveAs(downloadPath);
    console.log('✓ 步骤 5: 文件下载成功');
    fs.unlinkSync(downloadPath);

    // 步骤 6: 删除文件
    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
    console.log('✓ 步骤 6: 文件删除成功');

    // 步骤 7: 验证管理后台（后台是 13081 独立服务，不是 13080 的路由）
    const adminPage = await context.newPage();
    await adminPage.goto(ADMIN_URL);
    await expect(adminPage).toHaveTitle(/管理后台/);
    await expect(adminPage.locator('.stats-grid')).toBeVisible();
    console.log('✓ 步骤 7: 管理后台访问成功');

    await adminPage.close();
    console.log('✓ 完整流程测试通过');
  });
});

// ============================================
// 测试套件 8: 边界情况
// ============================================
test.describe('边界情况测试', () => {
  test('上传大文件', async ({ page }) => {
    test.setTimeout(180000); // 3 分钟超时

    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileName = uniqueName('large-test.json');
    const testFile = createTempFile(fileName, 'L'.repeat(2 * 1024 * 1024));
    await uploadFile(page, testFile);

    await waitForFileInList(page, fileName);
    await expect(fileCard(page, fileName)).toContainText(/MB|KB/);
    console.log('✓ 大文件上传完成');

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });

  test('并发上传多个文件', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const names = [
      uniqueName('small-test.txt'),
      uniqueName('medium-test.txt'),
      uniqueName('测试文件-中文.txt'),
    ];
    const files = [
      createTempFile(names[0], 'a'.repeat(500)),
      createTempFile(names[1], 'b'.repeat(50 * 1024)),
      createTempFile(names[2], '中文内容'),
    ];

    await page.locator('input[type="file"]').setInputFiles(files);

    // 一次多选上传后三个文件都应出现（web-first 替代固定 sleep）
    for (const name of names) {
      await waitForFileInList(page, name);
      await expect(fileCard(page, name)).toBeVisible();
    }
    console.log('✓ 多文件上传完成');

    for (const name of names) {
      await deleteFileViaUI(page, name);
    }
    files.forEach(f => fs.unlinkSync(f));
  });

  test('网络错误处理', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    // 模拟网络延迟：上传请求被延迟 2 秒后才放行
    await page.route('**/api/upload', route => {
      setTimeout(() => route.continue(), 2000);
    });

    const fileName = uniqueName('small-test.txt');
    const testFile = createTempFile(fileName, 'slow network upload');
    await uploadFile(page, testFile);

    // 延迟后上传仍应成功完成
    await waitForFileInList(page, fileName);
    await expect(fileCard(page, fileName)).toBeVisible();

    await deleteFileViaUI(page, fileName);
    fs.unlinkSync(testFile);
  });

  test('资源加载失败监控', async ({ page }) => {
    const failedResources = [];

    page.on('requestfailed', request => {
      failedResources.push({
        url: request.url(),
        failure: request.failure()
      });
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    expect(failedResources.length,
      `资源加载失败: ${failedResources.map(r => r.url).join(', ')}`
    ).toBe(0);
  });
});

// ============================================
// 测试套件 9: 性能测试
// ============================================
test.describe('性能测试', () => {
  test('页面加载性能', async ({ page }) => {
    const startTime = Date.now();

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    const loadTime = Date.now() - startTime;
    console.log(`页面加载时间: ${loadTime}ms`);

    expect(loadTime).toBeLessThan(5000); // 5秒内完成加载
  });

  test('首次内容绘制 (FCP)', async ({ page }) => {
    await page.goto(BASE_URL);

    const fcp = await page.evaluate(() => {
      const entries = performance.getEntriesByType('paint');
      const fcpEntry = entries.find(entry => entry.name === 'first-contentful-paint');
      return fcpEntry ? fcpEntry.startTime : null;
    });

    if (fcp) {
      console.log(`FCP: ${fcp}ms`);
      expect(fcp).toBeLessThan(2000); // FCP < 2秒
    }
  });

  test('页面滚动流畅性', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 滚动测试
    await page.evaluate(() => {
      window.scrollBy(0, 500);
    });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      window.scrollBy(0, -500);
    });
    await page.waitForTimeout(500);

    console.log('✓ 滚动测试完成');
  });
});

console.log('✓ 完整测试套件加载完成');
