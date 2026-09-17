import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 测试文件路径
const TEST_FILES_DIR = path.join(__dirname, '..', 'test_data', 'playwright_test');

// 本次运行的唯一标识：所有上传文件名带随机后缀，避免与历史残留文件重名，
// 同时保证用例可重复运行（服务端允许同名文件各存一份，重名会导致定位到多张卡片）。
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let nameSeq = 0;

function uniqueName(prefix, ext = 'txt') {
  nameSeq += 1;
  return `${prefix}-${RUN_ID}-${nameSeq}.${ext}`;
}

// 创建测试文件的辅助函数
function createTestFile(filename, sizeInBytes) {
  const filePath = path.join(TEST_FILES_DIR, filename);

  if (sizeInBytes < 1024) {
    // 小文件：直接写入文本
    const content = `Test file content - ${filename}\nSize: ${sizeInBytes} bytes\nCreated at: ${new Date().toISOString()}`;
    fs.writeFileSync(filePath, content.padEnd(sizeInBytes, ' '));
  } else {
    // 中大文件：创建Buffer并填充
    const buffer = Buffer.alloc(sizeInBytes);
    // 填充一些可识别的内容
    const header = `Test file: ${filename}\n`;
    buffer.write(header, 0);
    fs.writeFileSync(filePath, buffer);
  }

  return filePath;
}

// 格式化文件大小（与前端 App.jsx 中的 formatSize 保持一致）
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// 单个文件卡片的真实容器（服务端信息卡为 rounded-3xl，不会误匹配）
const fileCard = (page, name) =>
  page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: name }).first();
const allFileCards = page => page.locator('.bg-surface-3.rounded-2xl');

// 通过隐藏 input 上传并等待 POST /api/upload 响应返回（上传是异步的）
async function uploadViaInput(page, filePaths) {
  const responsePromise = page.waitForResponse(
    r => r.url().includes('/api/upload') && r.request().method() === 'POST'
  );
  await page.locator('input[type="file"]').setInputFiles(filePaths);
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  return response;
}

// web-first 等待文件卡片出现在列表中（上传完成后前端会重新拉取列表）
async function expectCardVisible(page, name) {
  const card = fileCard(page, name);
  await expect(card).toBeVisible({ timeout: 15000 });
  return card;
}

test.describe('文件上传流程测试', () => {
  // 每个用例创建的本机临时文件与服务器端文件名，afterEach 统一清理
  let localTempFiles = [];
  let serverFileNames = [];

  function createUniqueTestFile(prefix, sizeInBytes, ext = 'txt') {
    const name = uniqueName(prefix, ext);
    const filePath = createTestFile(name, sizeInBytes);
    localTempFiles.push(filePath);
    serverFileNames.push(name);
    return { name, size: sizeInBytes, path: filePath };
  }

  test.beforeAll(() => {
    // 创建测试文件目录
    if (!fs.existsSync(TEST_FILES_DIR)) {
      fs.mkdirSync(TEST_FILES_DIR, { recursive: true });
    }
  });

  test.afterEach(async ({ request }) => {
    // 清理本用例上传到服务器的文件（通过 API 删除，确保失败时也能清理）
    if (serverFileNames.length > 0) {
      const res = await request.get('/api/files');
      const list = await res.json();
      for (const f of list.filter(f => serverFileNames.includes(f.filename))) {
        await request.delete(`/api/files/${f.id}`);
      }
    }
    // 清理本用例创建的本机临时文件
    for (const p of localTempFiles) {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }
    localTempFiles = [];
    serverFileNames = [];
  });

  test.afterAll(() => {
    // 删除测试目录（如果为空）
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

  test.beforeEach(async ({ page }) => {
    // 每个测试前打开主页
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('应该成功上传小文件', async ({ page }) => {
    const testFile = createUniqueTestFile('small-test', 500); // 500 bytes

    // 获取上传前的文件大小（真实卡片容器为 .bg-surface-3.rounded-2xl）
    const filesBefore = await allFileCards(page).count();

    // 模拟文件上传（通过隐藏的input元素）
    await uploadViaInput(page, testFile.path);

    // 等待文件列表更新（web-first：等待新卡片出现）
    const card = await expectCardVisible(page, testFile.name);

    // 验证文件数量增加
    const filesAfter = await allFileCards(page).count();
    expect(filesAfter).toBeGreaterThan(filesBefore);

    // 验证文件名存在
    await expect(card.getByText(testFile.name, { exact: true })).toBeVisible();

    // 验证文件大小显示正确
    const sizeText = formatSize(testFile.size);
    await expect(card).toContainText(sizeText);
  });

  test('应该成功上传中等文件并显示进度', async ({ page }) => {
    const testFile = createUniqueTestFile('medium-test', 50 * 1024); // 50 KB

    // 监听网络请求
    let uploadStarted = false;
    page.on('request', request => {
      if (request.url().includes('/api/upload')) {
        uploadStarted = true;
      }
    });

    // 上传文件并等待上传响应返回
    await uploadViaInput(page, testFile.path);

    // 验证上传请求确实发出
    expect(uploadStarted).toBe(true);

    // 验证文件出现在列表中
    const card = await expectCardVisible(page, testFile.name);

    // 验证文件大小
    const sizeText = formatSize(testFile.size);
    await expect(card).toContainText(sizeText);
  });

  test('应该成功上传大文件', async ({ page }) => {
    const testFile = createUniqueTestFile('large-test', 2 * 1024 * 1024, 'json'); // 2 MB

    // 增加超时时间
    test.setTimeout(60000);

    // 上传文件并等待上传响应返回
    await uploadViaInput(page, testFile.path);

    // 验证文件出现在列表中
    const card = await expectCardVisible(page, testFile.name);

    // 验证文件大小显示为MB（前端 formatSize: <1GB 保留 1 位小数）
    await expect(card).toContainText('2.0 MB');
  });

  test('应该正确显示文件信息', async ({ page }) => {
    const testFile = createUniqueTestFile('info-test', 500);

    // 上传文件
    await uploadViaInput(page, testFile.path);

    // 等待并查找上传的文件项
    const card = await expectCardVisible(page, testFile.name);

    // 验证文件名
    await expect(card.getByText(testFile.name, { exact: true })).toBeVisible();

    // 验证文件大小（该文件为 500 字节）
    await expect(card).toContainText(formatSize(testFile.size));

    // 验证上传时间（应该包含"刚刚"或时间格式的相对时间）
    await expect(card).toContainText(/刚刚|秒前|分钟前|小时前|:/);
  });

  test('应该显示文件操作按钮', async ({ page }) => {
    const testFile = createUniqueTestFile('buttons-test', 500);

    // 上传文件
    await uploadViaInput(page, testFile.path);

    // 等待并查找上传的文件项
    const card = await expectCardVisible(page, testFile.name);

    // 验证下载按钮存在（真实按钮文案为“下载”）
    await expect(card.locator('button:has-text("下载")')).toBeVisible();

    // 验证删除按钮存在（真实按钮文案为“删除”）
    await expect(card.locator('button:has-text("删除")')).toBeVisible();

    // 验证其他操作按钮（收藏、二维码等，根据实际功能）
    const actionButtons = card.locator('button');
    const buttonCount = await actionButtons.count();
    expect(buttonCount).toBeGreaterThanOrEqual(2); // 至少有下载和删除
  });

  test('应该支持拖拽上传', async ({ page }) => {
    const dropName = uniqueName('drop-test');
    serverFileNames.push(dropName);

    // 查找上传区域（真实 DOM 中为包含“上传文件”标题的 <section>）
    const uploadArea = page.locator('section:has-text("上传文件")');
    await expect(uploadArea).toBeVisible();

    // 构造 dataTransfer 并派发 drop 事件，真正走拖拽上传路径
    const dataTransfer = await page.evaluateHandle(({ name }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([`Dropped file content - ${name}`], name, { type: 'text/plain' }));
      return dt;
    }, { name: dropName });
    await uploadArea.dispatchEvent('drop', { dataTransfer });

    // 验证文件通过拖拽上传成功（web-first 等待卡片出现）
    await expectCardVisible(page, dropName);
  });

  test('应该能够删除已上传的文件', async ({ page }) => {
    const testFile = createUniqueTestFile('delete-test', 500);

    // 上传文件
    await uploadViaInput(page, testFile.path);

    // 等待并查找上传的文件项
    const card = await expectCardVisible(page, testFile.name);

    // 删除会弹出原生 confirm，需要在点击前注册确认
    page.once('dialog', dialog => dialog.accept());

    // 等待 DELETE 响应与点击配对
    const deletePromise = page.waitForResponse(
      r => r.url().includes('/api/files/') && r.request().method() === 'DELETE'
    );
    await card.locator('button:has-text("删除")').click();
    const deleteResponse = await deletePromise;
    expect(deleteResponse.status()).toBe(200);

    // 验证文件已从列表中移除（web-first）
    await expect(fileCard(page, testFile.name)).toHaveCount(0);
  });

  test('应该能够下载已上传的文件', async ({ page }) => {
    const testFile = createUniqueTestFile('download-test', 500);

    // 上传文件
    await uploadViaInput(page, testFile.path);

    // 等待并查找上传的文件项
    const card = await expectCardVisible(page, testFile.name);

    // 点击下载（前端通过 window.open('/api/download/<id>') 触发浏览器下载）
    const downloadPromise = page.waitForEvent('download');
    await card.locator('button:has-text("下载")').click();

    // 验证下载开始
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(testFile.name);
  });

  test('应该支持同时上传多个文件', async ({ page }) => {
    const fileA = createUniqueTestFile('multi-a', 500);
    const fileB = createUniqueTestFile('multi-b', 50 * 1024);

    // 获取上传前的文件数量
    const filesBefore = await allFileCards(page).count();

    // 同时上传两个文件（一次 input 选择多个文件，POST /api/upload 字段名为 files）
    await uploadViaInput(page, [fileA.path, fileB.path]);

    // 等待两个文件都出现在列表中
    await expectCardVisible(page, fileA.name);
    await expectCardVisible(page, fileB.name);

    // 验证文件数量增加
    const filesAfter = await allFileCards(page).count();
    expect(filesAfter).toBeGreaterThanOrEqual(filesBefore + 2);
  });
});
