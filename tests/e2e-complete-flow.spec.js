import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_FILES_DIR = path.join(__dirname, '..', 'test_data', 'e2e_flow');
const ADMIN_URL = 'http://localhost:13081';

// 主应用文件卡片没有 .file-item 类（那是后台页面 13081 的行样式）；
// 主应用卡片真实类名为 div.bg-surface-3.rounded-2xl（服务信息卡片是 rounded-3xl，可区分）
const FILE_CARD_SELECTOR = 'div.bg-surface-3.rounded-2xl';

function createTestFile(filename, content, type = 'text') {
  const filePath = path.join(TEST_FILES_DIR, filename);

  if (type === 'text') {
    fs.writeFileSync(filePath, content, 'utf8');
  } else if (type === 'binary') {
    const buffer = Buffer.alloc(1024);
    buffer.write(content, 0);
    fs.writeFileSync(filePath, buffer);
  } else if (type === 'image') {
    const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  }

  return filePath;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileCard(page, fileName) {
  return page.locator(FILE_CARD_SELECTOR).filter({ hasText: fileName });
}

// 通过 UI 删除文件（原生 confirm 是同步阻塞对话框，必须在监听回调里立即应答，
// 否则 click 动作会被对话框卡住直至超时），以卡片消失为完成信号
async function deleteFileViaUI(page, fileName) {
  const card = fileCard(page, fileName);
  const deleteButton = card.locator('button').filter({ hasText: /删除|Delete/i }).first();
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

test.describe('完整用户流程：从上传到分享的端到端测试', () => {
  let testFiles = [];

  test.beforeAll(() => {
    if (!fs.existsSync(TEST_FILES_DIR)) {
      fs.mkdirSync(TEST_FILES_DIR, { recursive: true });
    }

    // 每次运行带唯一后缀，保证可重复运行且不与历史残留冲突
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    testFiles = [
      {
        name: `document-${runId}.txt`,
        path: null,
        type: 'text',
        content: 'This is a test document.\nLine 2\nLine 3'
      },
      {
        name: `test-image-${runId}.png`,
        path: null,
        type: 'image',
        content: null
      },
      {
        name: `binary-data-${runId}.bin`,
        path: null,
        type: 'binary',
        content: 'Binary test data content'
      }
    ];

    testFiles.forEach(file => {
      file.path = createTestFile(file.name, file.content, file.type);
      console.log(`Created test file: ${file.name}`);
    });
  });

  test.afterAll(() => {
    testFiles.forEach(file => {
      if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
        console.log(`Cleaned up: ${file.name}`);
      }
    });

    try {
      if (fs.existsSync(TEST_FILES_DIR)) {
        const files = fs.readdirSync(TEST_FILES_DIR);
        if (files.length === 0) {
          fs.rmdirSync(TEST_FILES_DIR);
        }
      }
    } catch (err) {
      console.log('Test directory cleanup skipped:', err.message);
    }
  });

  test('完整流程：上传 → 收藏 → 生成二维码 → 分享 → 下载 → 删除 → 后台验证', async ({ page, context }) => {
    test.setTimeout(120000);

    console.log('步骤 1: 打开主页');
    await page.goto('/');
    await expect(page).toHaveTitle(/本地文件交互系统|File Share/i);
    await expect(page.locator('h1')).toContainText('本地文件交互系统');
    console.log('✓ 主页加载成功');

    console.log('\n步骤 2: 上传多个文件（文本、图片、二进制）');
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();

    const filesBeforeUpload = await page.locator(FILE_CARD_SELECTOR).count();
    console.log(`上传前文件数量: ${filesBeforeUpload}`);

    await fileInput.setInputFiles([
      testFiles[0].path,
      testFiles[1].path,
      testFiles[2].path
    ]);

    // web-first：等待三个文件都出现在列表（WebSocket 通知 + fetchFiles 刷新）
    for (const file of testFiles) {
      await expect(fileCard(page, file.name)).toBeVisible({ timeout: 15000 });
      console.log(`✓ 文件已上传: ${file.name}`);
    }

    const filesAfterUpload = await page.locator(FILE_CARD_SELECTOR).count();
    console.log(`上传后文件数量: ${filesAfterUpload}`);
    expect(filesAfterUpload).toBeGreaterThanOrEqual(filesBeforeUpload + 3);

    console.log('\n步骤 3: 收藏第一个文件');
    const favoriteFileName = testFiles[0].name;
    const firstFileItem = fileCard(page, favoriteFileName);
    await expect(firstFileItem).toBeVisible();

    const favoriteButton = firstFileItem.locator('button').filter({ hasText: /收藏/ }).first();
    await expect(favoriteButton).toBeVisible();
    await expect(favoriteButton).toContainText('☆');

    await favoriteButton.click();
    // 收藏按钮真实文案：☆ 收藏 ⇄ ★ 已收藏（aria-pressed 同步）
    await expect(
      firstFileItem.locator('button').filter({ hasText: '★ 已收藏' })
    ).toBeVisible();
    await expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');
    console.log(`✓ 已收藏文件: ${favoriteFileName}`);

    console.log('\n步骤 4: 生成二维码分享');
    const qrButton = firstFileItem.locator('button').filter({ hasText: /二维码|QR/i }).first();
    await expect(qrButton).toBeVisible();

    const qrCodeResponse = page.waitForResponse(
      response => response.url().includes('/api/qrcode/') && response.status() === 200,
      { timeout: 10000 }
    );

    await qrButton.click();
    console.log('已点击二维码按钮');

    const response = await qrCodeResponse;
    const qrData = await response.json();

    expect(qrData).toHaveProperty('qrcode');
    expect(qrData).toHaveProperty('url');
    expect(qrData.qrcode).toMatch(/^data:image\/png;base64,/);
    expect(qrData.url).toMatch(/\/download\/[\w-]+$/);

    const qrCodeUrl = qrData.url;
    console.log(`✓ 二维码生成成功`);
    console.log(`分享链接: ${qrCodeUrl}`);

    // 弹窗中的二维码由 qrcode.react 渲染为 <svg>（不是 <img>/canvas）
    const qrDialog = page.locator('div.fixed.inset-0').filter({ hasText: '扫码下载' });
    await expect(qrDialog.getByRole('heading', { name: '扫码下载' })).toBeVisible();
    await expect(qrDialog.locator('svg')).toBeVisible();
    await expect(qrDialog.locator('.font-mono')).toHaveText(qrCodeUrl);
    console.log('✓ 二维码图片已显示');

    await qrDialog.locator('button').filter({ hasText: /关闭|取消|Close/i }).first().click();
    await expect(qrDialog).toHaveCount(0);

    console.log('\n步骤 5: 在新标签页中访问分享链接（模拟扫码）');
    const downloadPage = await context.newPage();
    const shareResponse = await downloadPage.goto(qrCodeUrl);
    expect(shareResponse.ok()).toBeTruthy();
    console.log(`✓ 已打开分享链接: ${qrCodeUrl}`);

    // 分享落地页显示被分享的文件名
    await expect(downloadPage.locator('h1')).toHaveText(favoriteFileName);

    console.log('\n步骤 6: 下载文件');
    const downloadButton = downloadPage.locator('button, a').filter({
      hasText: /下载|Download/i
    }).first();
    await expect(downloadButton).toBeVisible();

    const downloadPromise = downloadPage.waitForEvent('download', { timeout: 15000 });
    await downloadButton.click();

    const download = await downloadPromise;
    const downloadedFileName = download.suggestedFilename();
    console.log(`✓ 文件下载已触发: ${downloadedFileName}`);
    expect(downloadedFileName).toContain(favoriteFileName);

    const downloadPath = path.join(TEST_FILES_DIR, `downloaded-${downloadedFileName}`);
    await download.saveAs(downloadPath);
    expect(fs.statSync(downloadPath).size).toBe(fs.statSync(testFiles[0].path).size);
    fs.unlinkSync(downloadPath);

    await downloadPage.close();

    console.log('\n步骤 7: 返回主页');
    await page.bringToFront();
    await expect(page.locator('h1')).toBeVisible();
    console.log('✓ 已返回主页');

    console.log('\n步骤 8: 删除上传的文件');
    for (const file of testFiles) {
      await deleteFileViaUI(page, file.name);
      console.log(`✓ 已删除文件: ${file.name}`);
    }

    for (const file of testFiles) {
      await expect(page.getByText(file.name, { exact: true })).toHaveCount(0);
      console.log(`✓ 确认已删除: ${file.name}`);
    }

    console.log('\n步骤 9: 访问管理后台验证文件已删除（后台是 13081 独立服务）');
    const adminPage = await context.newPage();
    const fileListResponse = adminPage.waitForResponse(
      response => response.url().includes('/api/admin/files') && response.status() === 200,
      { timeout: 15000 }
    );

    await adminPage.goto(ADMIN_URL);
    await expect(adminPage).toHaveTitle(/管理后台/);
    console.log('✓ 管理后台页面加载成功');

    // 状态卡数据加载完成
    await expect(adminPage.locator('#fileCount')).not.toHaveText('-');

    const adminFiles = await (await fileListResponse).json();
    console.log(`后台文件列表数量: ${adminFiles.length}`);

    for (const file of testFiles) {
      const fileExistsInAdmin = adminFiles.some(f => f.filename === file.name);
      expect(fileExistsInAdmin).toBe(false);
      console.log(`✓ 后台确认文件已删除: ${file.name}`);
    }

    for (const file of testFiles) {
      await expect(adminPage.locator('#fileList .file-name', { hasText: file.name })).toHaveCount(0);
    }

    console.log('✓ 管理后台验证完成：所有测试文件已被删除');

    await adminPage.close();

    console.log('\n✅ 完整端到端测试流程执行成功！');
    console.log('测试涵盖：上传 → 收藏 → 二维码分享 → 下载 → 删除 → 后台验证');
  });

  test('辅助测试：验证上传文件的完整性', async ({ page }) => {
    console.log('验证文件上传功能');

    await page.goto('/');
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileInput = page.locator('input[type="file"]');
    const testFile = testFiles[0];

    await fileInput.setInputFiles(testFile.path);

    const card = fileCard(page, testFile.name);
    await expect(card).toBeVisible({ timeout: 15000 });

    // 卡片应显示与服务端一致的文件大小（前端 <1KB 显示 "<n> B"）
    const fileStats = fs.statSync(testFile.path);
    const expectedSize = formatSize(fileStats.size);
    console.log(`文件 ${testFile.name} 大小: ${expectedSize}`);
    await expect(card).toContainText(expectedSize);

    await deleteFileViaUI(page, testFile.name);
    console.log('✓ 文件上传完整性验证通过');
  });

  test('辅助测试：验证二维码 URL 可访问性', async ({ page, context }) => {
    console.log('验证二维码 URL 可访问性');

    await page.goto('/');
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFiles[0].path);

    const card = fileCard(page, testFiles[0].name);
    await expect(card).toBeVisible({ timeout: 15000 });

    const qrButton = card.locator('button').filter({ hasText: /二维码|QR/i }).first();
    await expect(qrButton).toBeVisible();

    const qrResponse = page.waitForResponse(
      response => response.url().includes('/api/qrcode/') && response.status() === 200,
      { timeout: 10000 }
    );

    await qrButton.click();
    const response = await qrResponse;
    const data = await response.json();

    const shareUrl = data.url;
    console.log(`分享 URL: ${shareUrl}`);
    expect(shareUrl).toMatch(/^https?:\/\//);

    // 关闭弹窗（弹窗遮罩会挡住后续对卡片的操作）
    const qrDialog = page.locator('div.fixed.inset-0').filter({ hasText: '扫码下载' });
    await expect(qrDialog.getByRole('heading', { name: '扫码下载' })).toBeVisible();
    await qrDialog.locator('button').filter({ hasText: '关闭' }).first().click();
    await expect(qrDialog).toHaveCount(0);

    const newPage = await context.newPage();
    const pageResponse = await newPage.goto(shareUrl);

    expect(pageResponse.ok()).toBeTruthy();
    expect(pageResponse.status()).toBe(200);
    // 落地页显示的就是被分享的文件
    await expect(newPage.locator('h1')).toHaveText(testFiles[0].name);
    console.log('✓ 分享 URL 可正常访问');

    await newPage.close();

    // 清理自己创建的文件
    await deleteFileViaUI(page, testFiles[0].name);
  });

  test('辅助测试：多文件并发操作', async ({ page }) => {
    console.log('测试多文件并发上传和删除');

    await page.goto('/');
    await expect(page.locator('h1')).toContainText('本地文件交互系统');

    const filesBeforeUpload = await page.locator(FILE_CARD_SELECTOR).count();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFiles.map(f => f.path));

    // web-first：三个文件全部出现才算上传完成
    for (const file of testFiles) {
      await expect(fileCard(page, file.name)).toBeVisible({ timeout: 15000 });
    }

    const filesAfterUpload = await page.locator(FILE_CARD_SELECTOR).count();
    expect(filesAfterUpload).toBeGreaterThanOrEqual(filesBeforeUpload + 3);
    console.log(`✓ 并发上传 ${testFiles.length} 个文件成功`);

    for (const file of testFiles) {
      await deleteFileViaUI(page, file.name);
    }

    for (const file of testFiles) {
      await expect(page.getByText(file.name, { exact: true })).toHaveCount(0);
    }

    console.log('✓ 多文件并发删除成功');
  });
});
