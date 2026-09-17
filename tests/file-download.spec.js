import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://localhost:13080';
const TEST_FILES_DIR = path.join(__dirname, '..', 'test_data', 'playwright_test');
const DOWNLOADS_DIR = path.join(__dirname, '..', 'test_data', 'downloads');

// 创建测试文件
function createTestFile(filename, content) {
  const filePath = path.join(TEST_FILES_DIR, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// 比较文件内容
function compareFileContent(filePath1, filePath2) {
  const content1 = fs.readFileSync(filePath1, 'utf8');
  const content2 = fs.readFileSync(filePath2, 'utf8');
  return content1 === content2;
}

// 格式化文件大小（与前端 App.jsx 中的 formatSize 保持一致）
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// 单个文件卡片的真实容器（页面没有表格，文件以卡片渲染）
const fileCard = (page, name) =>
  page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: name }).first();

// 上传并等待 POST /api/upload 响应返回，返回解析后的响应体
async function uploadViaInput(page, filePath) {
  const responsePromise = page.waitForResponse(
    r => r.url().includes('/api/upload') && r.request().method() === 'POST'
  );
  await page.locator('input[type="file"]').setInputFiles(filePath);
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  return response.json();
}

// web-first 等待文件卡片出现在列表中
async function expectCardVisible(page, name) {
  const card = fileCard(page, name);
  await expect(card).toBeVisible({ timeout: 15000 });
  return card;
}

test.describe('文件下载流程测试', () => {
  let testFilePath;
  const testFileName = `download-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const testContent = `This is a test file for download functionality.
Created at: ${new Date().toISOString()}
Line 3: Random content - ${Math.random().toString(36).substring(7)}
Line 4: End of test file.`;

  // 本用例文件上传到服务器的文件名，afterEach 统一通过 API 清理
  let serverFileNames = [];

  test.beforeAll(() => {
    // 创建测试目录
    if (!fs.existsSync(TEST_FILES_DIR)) {
      fs.mkdirSync(TEST_FILES_DIR, { recursive: true });
    }
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }

    // 创建测试文件
    testFilePath = createTestFile(testFileName, testContent);
    console.log(`Created test file: ${testFilePath}`);
  });

  test.afterEach(async ({ request }) => {
    // 清理本用例上传到服务器的文件，避免同名卡片累积影响后续用例
    if (serverFileNames.length > 0) {
      const res = await request.get('/api/files');
      const list = await res.json();
      for (const f of list.filter(f => serverFileNames.includes(f.filename))) {
        await request.delete(`/api/files/${f.id}`);
      }
    }
    serverFileNames = [];
  });

  test.afterAll(() => {
    // 清理测试文件
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
      console.log(`Cleaned up test file: ${testFilePath}`);
    }

    // 清理下载目录
    if (fs.existsSync(DOWNLOADS_DIR)) {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      files.forEach(file => {
        fs.unlinkSync(path.join(DOWNLOADS_DIR, file));
      });
      console.log('Cleaned up downloads directory');
    }
  });

  test('完整文件下载流程', async ({ page }) => {
    serverFileNames.push(testFileName);

    // 步骤 1: 访问页面
    await page.goto('/');
    await expect(page).toHaveTitle(/文件交互系统/);

    // 步骤 2: 上传测试文件
    console.log('Uploading test file...');
    await uploadViaInput(page, testFilePath);

    // 等待文件出现在列表中（web-first）
    const fileRow = await expectCardVisible(page, testFileName);
    console.log('File uploaded and visible in list');

    // 步骤 3: 校验列表中显示的文件大小与真实文件大小一致
    const expectedSizeText = formatSize(fs.statSync(testFilePath).size);
    console.log(`Expected file size in list: ${expectedSizeText}`);
    await expect(fileRow).toContainText(expectedSizeText);

    // 步骤 4: 设置下载监听器
    const downloadPromise = page.waitForEvent('download');

    // 步骤 5: 点击下载按钮（前端通过 window.open('/api/download/<id>') 触发下载）
    const downloadButton = fileRow.locator('button:has-text("下载")');
    await expect(downloadButton).toBeVisible();
    await downloadButton.click();
    console.log('Download button clicked');

    // 步骤 6: 等待下载事件
    const download = await downloadPromise;
    console.log(`Download started: ${download.suggestedFilename()}`);

    // 步骤 7: 验证文件名
    expect(download.suggestedFilename()).toBe(testFileName);

    // 步骤 8: 保存下载的文件
    const downloadPath = path.join(DOWNLOADS_DIR, testFileName);
    await download.saveAs(downloadPath);
    console.log(`Downloaded file saved to: ${downloadPath}`);

    // 步骤 9: 验证文件存在
    expect(fs.existsSync(downloadPath)).toBeTruthy();

    // 步骤 10: 验证文件大小
    const originalStats = fs.statSync(testFilePath);
    const downloadedStats = fs.statSync(downloadPath);
    expect(downloadedStats.size).toBe(originalStats.size);
    console.log(`File size match: ${downloadedStats.size} bytes`);

    // 步骤 11: 验证文件内容
    const contentMatch = compareFileContent(testFilePath, downloadPath);
    expect(contentMatch).toBeTruthy();
    console.log('File content verified: identical to original');
  });

  test('下载多个文件', async ({ page }) => {
    // 创建多个测试文件（文件名带运行标识，避免与历史残留重名）
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const testFiles = [
      { name: `multi-test-1-${runId}.txt`, content: 'File 1 content' },
      { name: `multi-test-2-${runId}.txt`, content: 'File 2 content with more text' },
      { name: `multi-test-3-${runId}.txt`, content: 'File 3 content' },
    ];

    const createdFiles = [];
    for (const file of testFiles) {
      const filePath = createTestFile(file.name, file.content);
      createdFiles.push({ name: file.name, path: filePath, content: file.content });
      serverFileNames.push(file.name);
    }

    try {
      await page.goto('/');

      // 上传所有文件（每个文件等待上传响应并出现在列表中）
      for (const file of createdFiles) {
        await uploadViaInput(page, file.path);
        await expectCardVisible(page, file.name);
      }

      // 依次下载每个文件并验证
      for (const file of createdFiles) {
        const downloadPromise = page.waitForEvent('download');
        const fileRow = fileCard(page, file.name);
        const downloadButton = fileRow.locator('button:has-text("下载")');
        await downloadButton.click();

        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(file.name);

        const downloadPath = path.join(DOWNLOADS_DIR, file.name);
        await download.saveAs(downloadPath);

        // 验证内容
        const downloadedContent = fs.readFileSync(downloadPath, 'utf8');
        expect(downloadedContent).toBe(file.content);
        console.log(`Verified download: ${file.name}`);
      }

    } finally {
      // 清理创建的测试文件
      for (const file of createdFiles) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }
  });

  test('下载按钮状态和可见性', async ({ page }) => {
    serverFileNames.push(testFileName);

    await page.goto('/');

    // 上传文件
    await uploadViaInput(page, testFilePath);

    // 等待文件出现在列表中
    const fileRow = await expectCardVisible(page, testFileName);

    // 检查下载按钮
    const downloadButton = fileRow.locator('button:has-text("下载")');

    // 验证按钮可见且可点击
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toBeEnabled();

    // 验证按钮样式（真实实现中下载按钮使用主题强调色 bg-accent，即蓝色 #38BDF8）
    const buttonClass = await downloadButton.getAttribute('class');
    expect(buttonClass).toContain('bg-accent');
  });

  test('下载不存在的文件处理', async ({ page }) => {
    // 直接尝试下载一个不存在的文件（真实下载路由为 GET /api/download/:id）
    const nonExistentId = 'non-existent-file-12345';

    const response = await page.goto(`${BASE_URL}/api/download/${nonExistentId}`);

    // 应该返回404错误响应
    expect(response).not.toBeNull();
    expect(response.status()).toBe(404);

    const body = await response.json();
    expect(body.error).toBeTruthy();
  });

  test('验证下载文件的MIME类型', async ({ page, request }) => {
    serverFileNames.push(testFileName);

    await page.goto('/');

    // 上传文件（上传响应中返回入库后的文件 id 与 mime_type）
    const uploadBody = await uploadViaInput(page, testFilePath);
    const uploaded = uploadBody.files.find(f => f.filename === testFileName);
    expect(uploaded).toBeTruthy();

    // 通过 API 直接校验下载响应的头部信息
    const downloadResponse = await request.get(`/api/download/${uploaded.id}`);
    expect(downloadResponse.status()).toBe(200);
    expect(downloadResponse.headers()['content-type']).toBe('text/plain');
    expect(downloadResponse.headers()['content-disposition']).toContain('attachment');

    // 等待下载事件（页面点击下载按钮）
    const downloadPromise = page.waitForEvent('download');

    const fileRow = await expectCardVisible(page, testFileName);
    const downloadButton = fileRow.locator('button:has-text("下载")');
    await downloadButton.click();

    const download = await downloadPromise;

    // 验证文件名
    expect(download.suggestedFilename()).toBe(testFileName);

    // 保存并验证
    const downloadPath = path.join(DOWNLOADS_DIR, testFileName);
    await download.saveAs(downloadPath);

    expect(fs.existsSync(downloadPath)).toBeTruthy();
  });
});
