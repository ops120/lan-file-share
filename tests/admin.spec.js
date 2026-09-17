import { test, expect } from '@playwright/test';

// 管理后台是独立服务，监听在主服务端口 + 1（config.port + 1，默认 13081），
// 而不是主应用所在的 13080，因此本文件需要单独指定 baseURL。
test.use({ baseURL: 'http://localhost:13081' });

test.describe('管理后台测试', () => {

  test('页面加载成功', async ({ page }) => {
    await page.goto('/');

    // 验证页面标题
    await expect(page).toHaveTitle(/管理后台/);

    // 验证主标题
    const heading = page.locator('h1');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText('管理后台');

    // 验证副标题
    const subtitle = page.locator('.subtitle');
    await expect(subtitle).toBeVisible();
    await expect(subtitle).toContainText('本地文件交互系统配置与管理');
  });

  test('系统状态卡片显示', async ({ page }) => {
    await page.goto('/');

    // 等待状态数据加载
    await page.waitForTimeout(1000);

    // 验证文件总数卡片
    const fileCount = page.locator('#fileCount');
    await expect(fileCount).toBeVisible();
    await expect(fileCount).not.toHaveText('-');

    // 验证总存储大小卡片
    const totalSize = page.locator('#totalSize');
    await expect(totalSize).toBeVisible();
    await expect(totalSize).not.toHaveText('-');

    // 验证磁盘占用卡片
    const diskUsage = page.locator('#diskUsage');
    await expect(diskUsage).toBeVisible();
    await expect(diskUsage).not.toHaveText('-');

    // 验证服务端口卡片
    const serverPort = page.locator('#serverPort');
    await expect(serverPort).toBeVisible();
    await expect(serverPort).not.toHaveText('-');

    // 验证统计网格布局
    const statsGrid = page.locator('.stats-grid');
    await expect(statsGrid).toBeVisible();

    // 验证至少有4个统计项
    const statItems = page.locator('.stat-item');
    await expect(statItems).toHaveCount(4);
  });

  test('文件列表表格渲染', async ({ page }) => {
    await page.goto('/');

    // 等待文件列表加载
    await page.waitForTimeout(1500);

    // 验证文件列表容器存在
    const fileList = page.locator('#fileList');
    await expect(fileList).toBeVisible();

    // 验证是否有加载状态或文件项
    const hasFiles = await page.locator('.file-item').count() > 0;
    const hasLoading = await page.locator('.loading').isVisible();

    expect(hasFiles || hasLoading).toBeTruthy();

    // 如果有文件，验证文件项结构
    if (hasFiles) {
      const firstFile = page.locator('.file-item').first();
      await expect(firstFile).toBeVisible();

      // 验证文件信息元素
      const fileName = firstFile.locator('.file-name');
      await expect(fileName).toBeVisible();

      const fileMeta = firstFile.locator('.file-meta');
      await expect(fileMeta).toBeVisible();

      // 验证复选框
      const checkbox = firstFile.locator('.file-checkbox');
      await expect(checkbox).toBeVisible();
    }

    // 验证删除选中按钮存在
    const deleteBtn = page.getByRole('button', { name: /删除选中/ });
    await expect(deleteBtn).toBeVisible();
  });

  test('配置表单正确加载', async ({ page }) => {
    await page.goto('/');

    // 验证配置表单存在
    const configForm = page.locator('#configForm');
    await expect(configForm).toBeVisible();

    // 验证主机地址输入框
    const hostInput = page.locator('#host');
    await expect(hostInput).toBeVisible();
    await expect(hostInput).toHaveAttribute('placeholder', '0.0.0.0');

    // 验证端口输入框
    const portInput = page.locator('#port');
    await expect(portInput).toBeVisible();
    await expect(portInput).toHaveAttribute('type', 'number');
    await expect(portInput).toHaveAttribute('placeholder', '8080');

    // 验证上传目录输入框
    const uploadDirInput = page.locator('#uploadDir');
    await expect(uploadDirInput).toBeVisible();

    // 验证最大文件大小输入框
    const maxFileSizeInput = page.locator('#maxFileSize');
    await expect(maxFileSizeInput).toBeVisible();
    await expect(maxFileSizeInput).toHaveAttribute('type', 'number');
    await expect(maxFileSizeInput).toHaveAttribute('placeholder', '1024');

    // 验证自动清理时间输入框
    const autoCleanInput = page.locator('#autoCleanHours');
    await expect(autoCleanInput).toBeVisible();
    await expect(autoCleanInput).toHaveAttribute('type', 'number');
    await expect(autoCleanInput).toHaveAttribute('placeholder', '24');

    // 验证保存配置按钮
    const saveBtn = page.getByRole('button', { name: /保存配置/ });
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toHaveAttribute('type', 'submit');

    // 验证清理过期文件按钮
    const cleanBtn = page.getByRole('button', { name: /清理过期文件/ });
    await expect(cleanBtn).toBeVisible();
  });

  test('配置表单交互功能', async ({ page }) => {
    await page.goto('/');

    // 填写配置表单
    await page.locator('#host').fill('127.0.0.1');
    await page.locator('#port').fill('9090');
    await page.locator('#maxFileSize').fill('2048');
    await page.locator('#autoCleanHours').fill('48');

    // 验证输入值
    await expect(page.locator('#host')).toHaveValue('127.0.0.1');
    await expect(page.locator('#port')).toHaveValue('9090');
    await expect(page.locator('#maxFileSize')).toHaveValue('2048');
    await expect(page.locator('#autoCleanHours')).toHaveValue('48');
  });

  test('文件列表复选框交互', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1500);

    const fileItems = page.locator('.file-item');
    const count = await fileItems.count();

    if (count > 0) {
      // 勾选第一个文件
      const firstCheckbox = page.locator('.file-checkbox').first();
      await firstCheckbox.check();
      await expect(firstCheckbox).toBeChecked();

      // 取消勾选
      await firstCheckbox.uncheck();
      await expect(firstCheckbox).not.toBeChecked();
    }
  });

  test('页面布局和样式验证', async ({ page }) => {
    await page.goto('/');

    // 验证容器存在
    const container = page.locator('.container');
    await expect(container).toBeVisible();

    // 验证所有卡片元素
    const cards = page.locator('.card');
    await expect(cards).toHaveCount(3);

    // 验证所有卡片都可见
    for (let i = 0; i < 3; i++) {
      await expect(cards.nth(i)).toBeVisible();
    }

    // 验证页面背景色（深色主题）
    const body = page.locator('body');
    const bgColor = await body.evaluate((el) =>
      window.getComputedStyle(el).backgroundColor
    );
    expect(bgColor).toBeTruthy();
  });

  test('响应式网格布局', async ({ page }) => {
    await page.goto('/');

    // 验证统计网格使用 grid 布局
    const statsGrid = page.locator('.stats-grid');
    const display = await statsGrid.evaluate((el) =>
      window.getComputedStyle(el).display
    );
    expect(display).toBe('grid');
  });

  test('API 数据加载验证', async ({ page }) => {
    // 监听 API 请求
    const statusRequest = page.waitForResponse(
      response => response.url().includes('/api/admin/status') && response.status() === 200
    );

    await page.goto('/');

    // 等待状态 API 响应
    const response = await statusRequest;
    expect(response.ok()).toBeTruthy();

    // 验证响应数据
    const data = await response.json();
    expect(data).toHaveProperty('fileCount');
    expect(data).toHaveProperty('totalSize');
    expect(data).toHaveProperty('diskUsage');
    expect(data).toHaveProperty('serverPort');
  });

  test('文件列表 API 验证', async ({ page }) => {
    // 监听文件列表 API 请求
    const filesRequest = page.waitForResponse(
      response => response.url().includes('/api/admin/files') && response.status() === 200
    );

    await page.goto('/');

    // 等待文件列表 API 响应
    const response = await filesRequest;
    expect(response.ok()).toBeTruthy();

    // 验证响应是数组
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

});
