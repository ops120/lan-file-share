// tests/homepage.spec.js
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:13080';

test.describe('主页测试', () => {
  // 在所有测试前确保页面加载无错误
  test.beforeEach(async ({ page }) => {
    // 捕获控制台错误
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error('浏览器控制台错误:', msg.text());
      }
    });

    // 捕获页面错误
    page.on('pageerror', error => {
      console.error('页面错误:', error);
    });
  });

  test('页面加载成功（200状态码）', async ({ page }) => {
    const response = await page.goto(BASE_URL);
    
    expect(response).not.toBeNull();
    expect(response.status()).toBe(200);
    expect(response.ok()).toBeTruthy();
  });

  test('标题正确显示', async ({ page }) => {
    await page.goto(BASE_URL);
    
    // 等待页面加载完成
    await page.waitForLoadState('domcontentloaded');
    
    // 检查页面标题
    const title = await page.title();
    expect(title).toBe('本地文件交互系统');
    
    // 检查页面内的标题元素
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('本地文件交互系统');
  });

  test('关键元素存在 - 上传区域', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // 检查上传区域容器
    const uploadArea = page.locator('text=拖拽文件到此处上传').locator('..');
    await expect(uploadArea).toBeVisible();
    
    // 检查上传按钮
    const uploadButton = page.locator('button:has-text("选择文件")');
    await expect(uploadButton).toBeVisible();
    await expect(uploadButton).toBeEnabled();
    
    // 检查上传图标和提示文本
    await expect(page.locator('text=拖拽文件到此处上传')).toBeVisible();
    await expect(page.locator('text=或点击按钮选择文件')).toBeVisible();
  });

  test('关键元素存在 - 文件列表区域', async ({ page, request }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 不依赖服务器上已有文件：本次上传一个唯一文件，确定性地验证列表区域结构
    const name = `homepage-list-${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('homepage list check')
    });

    const card = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: name }).first();
    await expect(card).toBeVisible();

    // 列表标题（带计数）与卡片内的关键操作按钮
    await expect(page.locator('h2', { hasText: '文件列表' })).toBeVisible();
    await expect(card.locator('button', { hasText: '下载' })).toBeVisible();
    await expect(card.locator('button', { hasText: '删除' })).toBeVisible();

    // 清理本次上传的文件
    const files = await (await request.get(`${BASE_URL}/api/files`)).json();
    const created = files.find(f => f.filename === name);
    if (created) {
      await request.delete(`${BASE_URL}/api/files/${created.id}`);
    }
  });

  test('关键元素存在 - 设置和服务器信息', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // 检查服务器信息区域
    const serverInfoSection = page.locator('text=服务地址').locator('..');
    await expect(serverInfoSection).toBeVisible();
    
    // 检查存储使用信息
    const storageInfo = page.locator('text=存储使用').locator('..');
    await expect(storageInfo).toBeVisible();
    
    // 检查连接二维码按钮
    const qrButton = page.locator('button:has-text("连接二维码")');
    await expect(qrButton).toBeVisible();
    await expect(qrButton).toBeEnabled();
  });

  test('页面无 JavaScript 错误', async ({ page }) => {
    const consoleErrors = [];
    const pageErrors = [];

    // 捕获控制台错误
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 捕获页面错误
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // 等待 React 应用完全加载
    await page.waitForTimeout(2000);

    // 断言没有错误
    expect(consoleErrors.length, `发现控制台错误: ${consoleErrors.join(', ')}`).toBe(0);
    expect(pageErrors.length, `发现页面错误: ${pageErrors.join(', ')}`).toBe(0);
  });

  test('响应式布局检查 - 桌面端', async ({ page }) => {
    // 设置桌面端视口
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 检查主容器布局
    const mainContainer = page.locator('main').first();
    await expect(mainContainer).toBeVisible();
    
    const mainBox = await mainContainer.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(mainBox.width).toBeGreaterThan(800); // 桌面端应该有足够宽度

    // 检查头部在桌面端正确显示
    const header = page.locator('header');
    await expect(header).toBeVisible();
    
    // 检查服务器信息和存储信息并排显示：
    // 真实 DOM 结构中，“服务地址”文本元素向上两级即并排布局所在的 flex 容器
    // （结构：flex 容器 > 左列 div > “服务地址”div），原写法再多取一层父级拿到的是外层卡片。
    const flexContainer = page.locator('text=服务地址').locator('../..');
    // flex 容器中同时包含“存储使用”，即两者在同一并排容器内
    await expect(flexContainer).toContainText('存储使用');
    const flexContainerClass = await flexContainer.getAttribute('class');
    expect(flexContainerClass).toContain('flex');
  });

  test('响应式布局检查 - 移动端', async ({ page }) => {
    // 设置移动端视口（iPhone 12 Pro）
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 检查页面在移动端可见
    const mainContainer = page.locator('main').first();
    await expect(mainContainer).toBeVisible();
    
    // 检查主要元素在移动端仍然可访问
    const header = page.locator('header');
    await expect(header).toBeVisible();
    
    const uploadButton = page.locator('button:has-text("选择文件")');
    await expect(uploadButton).toBeVisible();
    
    // 检查上传区域在移动端正确显示
    const uploadArea = page.locator('text=拖拽文件到此处上传').locator('..');
    await expect(uploadArea).toBeVisible();
    
    // 检查是否有横向滚动（不应该有）
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = 390;
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth);
  });

  test('拖拽交互功能测试', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 上传区是包含「上传文件」标题的 section，拖拽高亮类挂在这一层
    const dropZone = page.locator('section').filter({ hasText: '上传文件' }).first();
    await expect(dropZone).toBeVisible();

    // 初始未拖拽：虚线边框为普通态
    await expect(dropZone).toHaveClass(/border-surface-4/);

    // 拖拽进入：React onDragEnter 应把状态切到高亮态
    await dropZone.dispatchEvent('dragenter');
    await expect(dropZone).toHaveClass(/border-accent/);

    // 拖拽离开：高亮应被撤销
    await dropZone.dispatchEvent('dragleave');
    await expect(dropZone).toHaveClass(/border-surface-4/);
  });

  test('API 连通性检查', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 等待服务器信息加载
    await page.waitForTimeout(1000);

    // 检查服务器信息是否成功加载
    const serverUrl = page.locator('text=服务地址').locator('~ div').first();
    await expect(serverUrl).toBeVisible();
    
    const urlText = await serverUrl.textContent();
    expect(urlText).toMatch(/http:\/\/.+:\d+/);
  });

  test('所有资源加载成功', async ({ page }) => {
    const failedResources = [];

    // 监听资源加载失败
    page.on('requestfailed', request => {
      failedResources.push({
        url: request.url(),
        failure: request.failure()
      });
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // 等待所有资源加载
    await page.waitForTimeout(2000);

    // 断言没有资源加载失败
    expect(failedResources.length, 
      `资源加载失败: ${failedResources.map(r => r.url).join(', ')}`
    ).toBe(0);
  });
});
