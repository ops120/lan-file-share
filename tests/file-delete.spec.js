import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

test.describe('文件删除功能测试', () => {
  const testFileName = 'test-delete-file.txt';
  const testFileContent = 'This is a test file for deletion testing.';
  let uploadedFileId;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('完整删除流程测试', async ({ page }) => {
    // 步骤 1: 上传测试文件
    const testFilePath = path.join(process.cwd(), testFileName);
    fs.writeFileSync(testFilePath, testFileContent);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);

    // 等待文件上传完成
    await page.waitForTimeout(2000);

    // 验证文件出现在列表中
    const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: testFileName });
    await expect(fileItem).toBeVisible();

    // 获取上传文件的ID（从下载按钮的事件中提取）
    const downloadButton = fileItem.locator('button:has-text("下载")');
    await expect(downloadButton).toBeVisible();

    // 步骤 2: 点击删除按钮
    const deleteButton = fileItem.locator('button:has-text("删除")');
    await expect(deleteButton).toBeVisible();

    // 监听确认对话框
    page.on('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('确认删除此文件');
      await dialog.accept();
    });

    // 步骤 3-4: 点击删除并确认
    await deleteButton.click();

    // 步骤 5: 验证文件从列表中消失
    await page.waitForTimeout(1000);
    await expect(fileItem).not.toBeVisible();

    // 清理本地测试文件
    fs.unlinkSync(testFilePath);
  });

  test('删除操作的 API 调用验证', async ({ page }) => {
    // 上传测试文件
    const testFilePath = path.join(process.cwd(), testFileName);
    fs.writeFileSync(testFilePath, testFileContent);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);
    await page.waitForTimeout(2000);

    const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: testFileName });
    await expect(fileItem).toBeVisible();

    // 步骤 6: 监听删除 API 调用
    const deleteRequest = page.waitForResponse(
      response => response.url().includes('/api/files/') &&
                  response.request().method() === 'DELETE'
    );

    // 点击删除按钮
    const deleteButton = fileItem.locator('button:has-text("删除")');
    page.on('dialog', dialog => dialog.accept());
    await deleteButton.click();

    // 验证 API 调用成功
    const response = await deleteRequest;
    expect(response.status()).toBe(200);

    // 清理
    fs.unlinkSync(testFilePath);
  });

  test('删除后访问下载链接应该失败', async ({ page, request }) => {
    // 上传测试文件
    const testFilePath = path.join(process.cwd(), testFileName);
    fs.writeFileSync(testFilePath, testFileContent);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);
    await page.waitForTimeout(2000);

    const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: testFileName });

    // 获取文件列表以找到文件 ID
    const filesResponse = await page.request.get('/api/files');
    const files = await filesResponse.json();
    const uploadedFile = files.find(f => f.filename === testFileName);
    expect(uploadedFile).toBeTruthy();
    const fileId = uploadedFile.id;

    // 验证下载链接在删除前可访问
    const downloadUrlBefore = `/api/download/${fileId}`;
    const downloadResponseBefore = await request.get(downloadUrlBefore);
    expect(downloadResponseBefore.status()).toBe(200);

    // 删除文件
    const deleteButton = fileItem.locator('button:has-text("删除")');
    page.on('dialog', dialog => dialog.accept());
    await deleteButton.click();
    await page.waitForTimeout(1000);

    // 步骤 7: 尝试访问已删除文件的下载链接
    const downloadUrlAfter = `/api/download/${fileId}`;
    const downloadResponseAfter = await request.get(downloadUrlAfter);

    // 验证返回 404 或其他错误状态
    expect(downloadResponseAfter.status()).toBeGreaterThanOrEqual(400);
    expect(downloadResponseAfter.ok()).toBeFalsy();

    // 清理
    fs.unlinkSync(testFilePath);
  });

  test('取消删除确认对话框', async ({ page }) => {
    // 上传测试文件
    const testFilePath = path.join(process.cwd(), testFileName);
    fs.writeFileSync(testFilePath, testFileContent);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);
    await page.waitForTimeout(2000);

    const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: testFileName });
    await expect(fileItem).toBeVisible();

    // 监听确认对话框并取消
    page.on('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      await dialog.dismiss();
    });

    // 点击删除按钮
    const deleteButton = fileItem.locator('button:has-text("删除")');
    await deleteButton.click();

    // 等待一下，确保没有删除操作发生
    await page.waitForTimeout(1000);

    // 验证文件仍然存在
    await expect(fileItem).toBeVisible();

    // 验证文件仍在列表中
    const filesResponse = await page.request.get('/api/files');
    const files = await filesResponse.json();
    const stillExists = files.some(f => f.filename === testFileName);
    expect(stillExists).toBeTruthy();

    // 清理：强制删除测试文件
    page.removeAllListeners('dialog');
    page.on('dialog', dialog => dialog.accept());
    await deleteButton.click();
    await page.waitForTimeout(1000);
    fs.unlinkSync(testFilePath);
  });

  test('删除按钮样式和交互状态', async ({ page }) => {
    // 上传测试文件
    const testFilePath = path.join(process.cwd(), testFileName);
    fs.writeFileSync(testFilePath, testFileContent);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);
    await page.waitForTimeout(2000);

    const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: testFileName });
    const deleteButton = fileItem.locator('button:has-text("删除")');

    // 验证删除按钮样式
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();
    
    // 验证按钮包含正确的 CSS 类
    const buttonClasses = await deleteButton.getAttribute('class');
    expect(buttonClasses).toContain('text-red-400');
    expect(buttonClasses).toContain('rounded-full');

    // 验证 hover 状态（通过检查类）
    expect(buttonClasses).toContain('hover:bg-red-900/50');

    // 清理
    page.on('dialog', dialog => dialog.accept());
    await deleteButton.click();
    await page.waitForTimeout(1000);
    fs.unlinkSync(testFilePath);
  });

  test('删除多个文件顺序执行', async ({ page }) => {
    const testFiles = [
      { name: 'test-delete-1.txt', content: 'Test file 1' },
      { name: 'test-delete-2.txt', content: 'Test file 2' },
      { name: 'test-delete-3.txt', content: 'Test file 3' }
    ];

    // 上传多个测试文件
    for (const file of testFiles) {
      const filePath = path.join(process.cwd(), file.name);
      fs.writeFileSync(filePath, file.content);

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(filePath);
      await page.waitForTimeout(1500);
    }

    // 验证所有文件都上传成功
    for (const file of testFiles) {
      const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: file.name });
      await expect(fileItem).toBeVisible();
    }

    // 依次删除所有文件
    page.on('dialog', dialog => dialog.accept());

    for (const file of testFiles) {
      const fileItem = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: file.name });
      const deleteButton = fileItem.locator('button:has-text("删除")');
      await deleteButton.click();
      await page.waitForTimeout(1000);

      // 验证当前文件已消失
      await expect(fileItem).not.toBeVisible();
    }

    // 验证所有文件都已从列表中移除
    const filesResponse = await page.request.get('/api/files');
    const files = await filesResponse.json();
    
    for (const file of testFiles) {
      const exists = files.some(f => f.filename === file.name);
      expect(exists).toBeFalsy();
    }

    // 清理本地文件
    for (const file of testFiles) {
      const filePath = path.join(process.cwd(), file.name);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  test('WebSocket 实时删除通知', async ({ page, context }) => {
    // 上传测试文件
    const testFilePath = path.join(process.cwd(), testFileName);
    fs.writeFileSync(testFilePath, testFileContent);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);
    await page.waitForTimeout(2000);

    // 打开第二个页面模拟另一个客户端
    const page2 = await context.newPage();
    await page2.goto('/');
    await page2.waitForLoadState('networkidle');

    // 验证两个页面都能看到文件
    const fileItem1 = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: testFileName });
    const fileItem2 = page2.locator('.bg-surface-3.rounded-2xl').filter({ hasText: testFileName });
    
    await expect(fileItem1).toBeVisible();
    await expect(fileItem2).toBeVisible();

    // 在第一个页面删除文件
    const deleteButton = fileItem1.locator('button:has-text("删除")');
    page.on('dialog', dialog => dialog.accept());
    await deleteButton.click();

    // 等待 WebSocket 通知传播
    await page.waitForTimeout(2000);

    // 验证第二个页面的文件也消失了（通过 WebSocket 实时更新）
    await expect(fileItem2).not.toBeVisible();

    await page2.close();
    fs.unlinkSync(testFilePath);
  });

  test('空列表状态显示', async ({ page }) => {
    // 不能用「删光服务器上所有文件」来制造空列表：uploads 是真实共享目录，
    // 这里改为把 /api/files 的响应替换为空数组，只验证前端空状态分支的渲染。
    await page.route('**/api/files', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]'
    }));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('text=暂无文件')).toBeVisible();
    await expect(page.locator('text=📭')).toBeVisible();
  });
});
