import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_FILES_DIR = path.join(__dirname, '..', 'test_data', 'playwright_test');

// 本次运行的唯一标识：所有上传文件名带随机后缀，避免与历史残留的同名文件
// 同时匹配导致 strict mode violation（服务端允许同名文件各存一份）。
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let nameSeq = 0;

function uniqueName(prefix) {
  nameSeq += 1;
  return `${prefix}-${RUN_ID}-${nameSeq}.txt`;
}

// 单个文件卡片的真实容器（服务端信息卡为 rounded-3xl，不会误匹配）
const fileCard = (page, name) =>
  page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: name }).first();

// 收藏接口的响应匹配
const isFavoriteResponse = r =>
  r.url().includes('/api/files/') &&
  r.url().includes('/favorite') &&
  r.request().method() === 'POST';

// 写入本机临时测试文件（用例结束后统一清理）
function writeLocalFile(name, content) {
  if (!fs.existsSync(TEST_FILES_DIR)) {
    fs.mkdirSync(TEST_FILES_DIR, { recursive: true });
  }
  const filePath = path.join(TEST_FILES_DIR, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// 上传文件并等待它出现在列表中
async function uploadAndWaitCard(page, filePath, fileName, serverFileNames, localFiles) {
  const responsePromise = page.waitForResponse(
    r => r.url().includes('/api/upload') && r.request().method() === 'POST'
  );
  await page.locator('input[type="file"]').setInputFiles(filePath);
  const response = await responsePromise;
  expect(response.status()).toBe(200);

  const card = fileCard(page, fileName);
  await expect(card).toBeVisible({ timeout: 15000 });
  serverFileNames.push(fileName);
  localFiles.push(filePath);
  return card;
}

test.describe('文件收藏功能测试', () => {
  const testFileContent = 'This is a test file for favorite feature testing.';

  // 本次用例创建的服务器端文件名与本机临时文件
  let serverFileNames = [];
  let localFiles = [];

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ request }) => {
    // 清理本用例上传到服务器的文件（通过 API 删除，确保用例中途失败也能清理）
    if (serverFileNames.length > 0) {
      const res = await request.get('/api/files');
      const list = await res.json();
      for (const f of list.filter(f => serverFileNames.includes(f.filename))) {
        await request.delete(`/api/files/${f.id}`);
      }
    }
    // 清理本机临时文件
    for (const p of localFiles) {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }
    serverFileNames = [];
    localFiles = [];
  });

  test('完整收藏功能流程测试', async ({ page }) => {
    // 步骤 1: 上传测试文件（唯一文件名）
    const testFileName = uniqueName('fav-flow');
    const testFilePath = writeLocalFile(testFileName, testFileContent);

    const fileItem = await uploadAndWaitCard(
      page, testFilePath, testFileName, serverFileNames, localFiles
    );

    // 步骤 2: 点击收藏按钮
    const favoriteButton = fileItem.locator('button').filter({ hasText: /收藏|星标/ }).first();

    // 如果找不到收藏按钮，说明功能尚未实现，测试将失败
    await expect(favoriteButton).toBeVisible({ timeout: 5000 });

    // 监听收藏 API 调用（先注册等待，再点击，与请求配对）
    const favoritePromise = page.waitForResponse(isFavoriteResponse, { timeout: 10000 });

    // 点击收藏按钮
    await favoriteButton.click();

    // 步骤 3: 验证按钮状态变化（星标高亮）
    await expect(fileItem.locator('button.is-favorite')).toContainText('已收藏');

    // 步骤 4: 检查 API 调用成功
    const favoriteResponse = await favoritePromise;
    expect(favoriteResponse.status()).toBe(200);

    const responseData = await favoriteResponse.json();
    expect(responseData.success).toBe(true);
    expect(responseData.is_favorite).toBe(1);

    // 步骤 5: 刷新页面后验证收藏状态持久化
    await page.reload();
    await page.waitForLoadState('networkidle');

    // 验证文件仍在列表中
    const fileItemAfterReload = fileCard(page, testFileName);
    await expect(fileItemAfterReload).toBeVisible({ timeout: 10000 });

    // 验证收藏状态persist（按钮应显示“已收藏”且带高亮类）
    const favoriteButtonAfterReload = fileItemAfterReload
      .locator('button.is-favorite')
      .filter({ hasText: /收藏|星标/ })
      .first();
    await expect(favoriteButtonAfterReload).toBeVisible();
    await expect(favoriteButtonAfterReload).toContainText('★ 已收藏');

    // 步骤 6: 取消收藏并验证状态更新（先注册等待，再点击）
    const unfavoritePromise = page.waitForResponse(isFavoriteResponse, { timeout: 10000 });

    // 再次点击收藏按钮（取消收藏）
    await favoriteButtonAfterReload.click();

    // 验证取消收藏的 API 调用
    const unfavoriteResponse = await unfavoritePromise;
    expect(unfavoriteResponse.status()).toBe(200);

    const unfavoriteData = await unfavoriteResponse.json();
    expect(unfavoriteData.success).toBe(true);
    expect(unfavoriteData.is_favorite).toBe(0);

    // 验证按钮恢复到未收藏状态
    await expect(fileItemAfterReload.locator('button.is-favorite')).toHaveCount(0);
    await expect(fileItemAfterReload.locator('button.favorite-button')).toContainText('☆ 收藏');
  });

  test('验证收藏状态在文件列表中正确显示', async ({ page }) => {
    // 上传测试文件（唯一文件名）
    const testFileName = uniqueName('fav-display');
    const testFilePath = writeLocalFile(testFileName, testFileContent);

    const fileItem = await uploadAndWaitCard(
      page, testFilePath, testFileName, serverFileNames, localFiles
    );

    // 收藏文件
    const favoriteButton = fileItem.locator('button').filter({ hasText: /收藏|星标/ }).first();
    await expect(favoriteButton).toBeVisible({ timeout: 5000 });

    // 等待响应与点击配对：先注册 waitForResponse，再点击，再 await
    const favoritePromise = page.waitForResponse(isFavoriteResponse, { timeout: 10000 });
    await favoriteButton.click();
    const favoriteResponse = await favoritePromise;
    expect(favoriteResponse.status()).toBe(200);

    const responseData = await favoriteResponse.json();
    expect(responseData.success).toBe(true);
    expect(responseData.is_favorite).toBe(1);

    // 验证文件项有收藏标识（收藏按钮带 favorite-button/is-favorite 类）
    const favoriteIndicator = fileItem.locator('[class*="favorite"], [class*="star"], [class*="收藏"]');

    // 至少应该有一个收藏状态的视觉指示
    const count = await favoriteIndicator.count();
    expect(count).toBeGreaterThan(0);

    // 且当前处于已收藏高亮状态
    await expect(fileItem.locator('button.is-favorite')).toBeVisible();
  });

  test('收藏和取消收藏快速切换', async ({ page }) => {
    // 上传测试文件（唯一文件名）
    const testFileName = uniqueName('fav-toggle');
    const testFilePath = writeLocalFile(testFileName, testFileContent);

    const fileItem = await uploadAndWaitCard(
      page, testFilePath, testFileName, serverFileNames, localFiles
    );
    const favoriteButton = fileItem.locator('button').filter({ hasText: /收藏|星标/ }).first();

    await expect(favoriteButton).toBeVisible({ timeout: 5000 });

    // 连续切换收藏状态 3 次
    for (let i = 0; i < 3; i++) {
      const responsePromise = page.waitForResponse(isFavoriteResponse, { timeout: 10000 });

      await favoriteButton.click();

      const response = await responsePromise;
      expect(response.status()).toBe(200);

      // 切换语义：初始未收藏，第 1/3 次点击后为已收藏(1)，第 2 次为未收藏(0)
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.is_favorite).toBe(i % 2 === 0 ? 1 : 0);

      // 等待按钮状态与收藏结果一致（web-first）
      if (i % 2 === 0) {
        await expect(fileItem.locator('button.is-favorite')).toBeVisible();
      } else {
        await expect(fileItem.locator('button.is-favorite')).toHaveCount(0);
      }
    }
  });

  test('多个文件独立收藏状态', async ({ page }) => {
    // 上传两个测试文件（唯一文件名）
    const testFile1 = uniqueName('fav-multi-1');
    const testFile2 = uniqueName('fav-multi-2');

    const testFilePath1 = writeLocalFile(testFile1, 'Content 1');
    const testFilePath2 = writeLocalFile(testFile2, 'Content 2');

    // 上传第一个文件
    await uploadAndWaitCard(page, testFilePath1, testFile1, serverFileNames, localFiles);

    // 上传第二个文件
    await uploadAndWaitCard(page, testFilePath2, testFile2, serverFileNames, localFiles);

    // 只收藏第一个文件（等待响应与点击配对）
    const fileItem1 = fileCard(page, testFile1);
    const favoriteButton1 = fileItem1.locator('button').filter({ hasText: /收藏|星标/ }).first();

    await expect(favoriteButton1).toBeVisible({ timeout: 5000 });
    const favoritePromise = page.waitForResponse(isFavoriteResponse, { timeout: 10000 });
    await favoriteButton1.click();
    const favoriteResponse = await favoritePromise;
    expect(favoriteResponse.status()).toBe(200);

    // 刷新页面
    await page.reload();
    await page.waitForLoadState('networkidle');

    // 验证第一个文件仍在列表中
    const fileItem1Reload = fileCard(page, testFile1);
    await expect(fileItem1Reload).toBeVisible({ timeout: 10000 });

    // 验证第二个文件没有收藏状态
    const fileItem2Reload = fileCard(page, testFile2);
    await expect(fileItem2Reload).toBeVisible({ timeout: 10000 });

    // 收藏状态持久化：第一个文件显示已收藏，第二个文件仍为未收藏
    await expect(fileItem1Reload.locator('button.is-favorite')).toContainText('★ 已收藏');
    await expect(fileItem2Reload.locator('button.is-favorite')).toHaveCount(0);
    await expect(fileItem2Reload.locator('button.favorite-button')).toContainText('☆ 收藏');
  });
});
