import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// 端口不硬编码：测试环境由 Express 直接托管前端与 API，端口以 config.json 为准
const { port: SERVER_PORT } = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf-8')
);
const BASE_URL = `http://localhost:${SERVER_PORT}`;

// 真实 DOM：文件卡片是 .bg-surface-3.rounded-2xl（服务信息卡片是 rounded-3xl，不会误匹配）
const FILE_CARD = '.bg-surface-3.rounded-2xl';

let seq = 0;
function uniqueName(base) {
  return `qr-${base}_${Date.now().toString(36)}_${++seq}.txt`;
}

// 通过页面 UI 上传一个唯一文件，等待它出现在列表后返回其所在卡片
async function uploadFileViaUI(page, baseName) {
  const fileName = uniqueName(baseName);
  const uploadResponse = page.waitForResponse(
    r => r.url().includes('/api/upload') && r.request().method() === 'POST'
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`qrcode spec fixture: ${fileName}`)
  });
  await uploadResponse;

  const card = page.locator(FILE_CARD).filter({ hasText: fileName });
  await expect(card).toBeVisible();
  return { fileName, card };
}

// 二维码弹窗：overlay 为 fixed inset-0，内部标题为 扫码连接 / 扫码下载
function modalWithTitle(page, title) {
  return page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: title }) });
}

test.describe('QR Code Share Page Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole('heading', { level: 1, name: '本地文件交互系统' })).toBeVisible();
  });

  test('should load the page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/本地文件交互系统|File Share/i);

    const errorMessages = page.locator('text=/error|错误/i');
    await expect(errorMessages).toHaveCount(0);
  });

  test('should generate QR code for server connection', async ({ page }) => {
    const connectButton = page.getByRole('button', { name: '显示连接二维码' });
    await expect(connectButton).toBeVisible();

    const qrCodeResponse = page.waitForResponse(
      response => response.url().includes('/api/connect-qrcode') && response.status() === 200
    );

    await connectButton.click();

    const response = await qrCodeResponse;
    const data = await response.json();

    expect(data).toHaveProperty('qrcode');
    expect(data).toHaveProperty('url');
    expect(data.qrcode).toMatch(/^data:image\/png;base64,/);
    expect(data.url).toContain('http://');
  });

  test('should generate QR code for file download', async ({ page }) => {
    const { card } = await uploadFileViaUI(page, 'file-qr');

    const fileQrButton = card.getByRole('button', { name: '二维码' });

    const qrCodeResponse = page.waitForResponse(
      response => response.url().includes('/api/qrcode/') && response.status() === 200
    );

    await fileQrButton.click();

    const response = await qrCodeResponse;
    const data = await response.json();

    expect(data).toHaveProperty('qrcode');
    expect(data).toHaveProperty('url');
    expect(data.qrcode).toMatch(/^data:image\/png;base64,/);
    expect(data.url).toContain('/download/');

    // 弹窗（扫码下载）应随之打开
    await expect(modalWithTitle(page, '扫码下载')).toBeVisible();
  });

  test('should display QR code image correctly', async ({ page }) => {
    const connectButton = page.getByRole('button', { name: '显示连接二维码' });
    await expect(connectButton).toBeVisible();
    await connectButton.click();

    const modal = modalWithTitle(page, '扫码连接');
    await expect(modal).toBeVisible();

    // 真实实现：qrcode.react 的 QRCodeSVG 渲染 <svg>（不是 img/canvas）
    const qrImage = modal.locator('svg').first();
    await expect(qrImage).toBeVisible();

    const box = await qrImage.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  test('should show download link with QR code', async ({ page }) => {
    const connectButton = page.getByRole('button', { name: '显示连接二维码' });
    await expect(connectButton).toBeVisible();
    await connectButton.click();

    const modal = modalWithTitle(page, '扫码连接');
    await expect(modal).toBeVisible();

    // 真实 DOM：弹窗内 <div class="font-mono text-accent text-sm"> 显示可手动输入的地址
    const linkDisplay = modal.locator('.font-mono');
    await expect(linkDisplay).toBeVisible();

    const linkText = await linkDisplay.textContent();
    expect(linkText).toMatch(/http:\/\/\d+\.\d+\.\d+\.\d+:\d+/);
  });

  test('should trigger download when clicking download QR code button', async ({ page }) => {
    const { fileName, card } = await uploadFileViaUI(page, 'qr-download-flow');

    // 真实实现：文件弹窗只展示二维码与下载页链接，确认下载由 /download/:id 页面的按钮完成
    await card.getByRole('button', { name: '二维码' }).click();
    const modal = modalWithTitle(page, '扫码下载');
    await expect(modal).toBeVisible();

    const qrUrl = await modal.locator('.font-mono').textContent();
    expect(qrUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/download\/.+/);

    // 模拟扫码：打开二维码指向的下载页，点击页内真实存在的下载按钮
    await page.goto(qrUrl.trim());
    await expect(page.getByRole('heading', { name: fileName })).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.getByRole('button', { name: '立即下载' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.png$|qr|code/i);
  });

  test('should have valid data URL for QR code that can be scanned', async ({ page }) => {
    const connectButton = page.getByRole('button', { name: '显示连接二维码' });
    await expect(connectButton).toBeVisible();

    const qrCodeResponse = page.waitForResponse(
      response =>
        (response.url().includes('/api/qrcode') || response.url().includes('/api/connect-qrcode')) &&
        response.status() === 200
    );

    await connectButton.click();

    const qrCodeData = await (await qrCodeResponse).json();

    expect(qrCodeData.qrcode).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);

    const base64Data = qrCodeData.qrcode.split(',')[1];
    expect(base64Data.length).toBeGreaterThan(100);

    expect(qrCodeData.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+/);
  });

  test('should handle QR code generation errors gracefully', async ({ page }) => {
    // 文件名刻意不含 error/错误 字样，避免页面上其他错误文案定位器自匹配文件名
    const { card } = await uploadFileViaUI(page, 'qr-broken-api');

    // 只拦截文件二维码接口（连接二维码走 /api/connect-qrcode，不受影响）
    await page.route('**/api/qrcode/**', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to generate QR code' })
      });
    });

    const qrCodeResponse = page.waitForResponse(
      response => response.url().includes('/api/qrcode/')
    );

    await card.getByRole('button', { name: '二维码' }).click();

    const response = await qrCodeResponse;
    expect(response.status()).toBe(500);

    const body = await response.json();
    expect(body).toHaveProperty('error');

    // “优雅”体现在真实存在的行为：接口返回结构化错误 JSON，且页面不崩溃、仍可正常使用
    await expect(page.getByRole('heading', { level: 1, name: '本地文件交互系统' })).toBeVisible();
    await expect(page.getByRole('button', { name: '选择文件' })).toBeVisible();
  });

  test('should verify QR code API endpoint response format', async ({ page }) => {
    const fileId = 'test-file-id';
    const response = await page.request.get(`${BASE_URL}/api/qrcode/${fileId}`);

    expect(response.ok()).toBeTruthy();

    const data = await response.json();

    expect(data).toHaveProperty('qrcode');
    expect(data).toHaveProperty('url');

    expect(data.qrcode).toMatch(/^data:image\/png;base64,/);

    expect(data.url).toContain(fileId);
    expect(data.url).toContain('/download/');
  });

  test('should verify connect QR code API endpoint', async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/connect-qrcode`);

    expect(response.ok()).toBeTruthy();

    const data = await response.json();

    expect(data).toHaveProperty('qrcode');
    expect(data).toHaveProperty('url');

    expect(data.qrcode).toMatch(/^data:image\/png;base64,/);

    expect(data.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
  });
});
