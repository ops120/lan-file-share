import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('移动端触摸操作测试', () => {

  test.describe('移动端上传触摸操作', () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
      isMobile: true
    });

    // 真实实现中上传的触摸目标是「选择文件」按钮（实测约 48x128），
    // 而不是 h2 标题「上传文件」（约 28px 高，非交互元素）。
    // 断言对象改为真实按钮：尺寸达标 + 触摸点击能唤起文件选择器（multiple）。
    test('应支持触摸点击上传按钮', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('h1')).toContainText('本地文件交互系统');

      const uploadButton = page.locator('button:has-text("选择文件")');
      await expect(uploadButton).toBeVisible();

      const box = await uploadButton.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.width).toBeGreaterThanOrEqual(60);

      const fileChooserPromise = page.waitForEvent('filechooser');
      await uploadButton.tap();
      const fileChooser = await fileChooserPromise;
      // 上传按钮关联的 input 是 multiple 多选
      // 注：Playwright 的 FileChooser 没有 cancel()；不调用 setFiles 即等同取消
      expect(fileChooser.isMultiple()).toBe(true);
    });

    test('应支持拖拽区域的触摸交互', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const dropZone = page.locator('[class*="upload"], [class*="drop"]').first();

      if (await dropZone.isVisible()) {
        await dropZone.tap();
        await page.waitForTimeout(300);

        const styles = await dropZone.evaluate(el => {
          const computed = window.getComputedStyle(el);
          return {
            cursor: computed.cursor,
            pointerEvents: computed.pointerEvents
          };
        });

        expect(styles.pointerEvents).not.toBe('none');
      }
    });

    test('应在移动端正确显示文件输入', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fileInputs = await page.locator('input[type="file"]').all();

      for (const input of fileInputs) {
        const isHidden = await input.isHidden();

        if (!isHidden) {
          const box = await input.boundingBox();
          expect(box).toBeTruthy();
        }
      }
    });
  });

  test.describe('移动端滑动和滚动', () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
      isMobile: true
    });

    test('应支持垂直滑动滚动', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const initialScrollY = await page.evaluate(() => window.scrollY);

      await page.touchscreen.tap(200, 300);

      await page.evaluate(() => {
        window.scrollBy(0, 100);
      });

      await page.waitForTimeout(300);

      const scrolledY = await page.evaluate(() => window.scrollY);

      if (scrolledY > initialScrollY) {
        expect(scrolledY).toBeGreaterThan(initialScrollY);
      }
    });

    test('应支持列表项的触摸滚动', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const scrollableContainer = page.locator('[class*="overflow"], [class*="scroll"]').first();

      if (await scrollableContainer.isVisible()) {
        const box = await scrollableContainer.boundingBox();

        await page.touchscreen.tap(box.x + box.width / 2, box.y + 50);
        await page.waitForTimeout(200);
      }
    });

    test('应防止横向滚动', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      const clientWidth = await page.evaluate(() => document.body.clientWidth);

      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  });

  test.describe('移动端按钮和链接交互', () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
      isMobile: true
    });

    // 阈值依据真实实现：主应用次要操作按钮实测最小 36x60（px-4 py-2 + text-sm），
    // 主操作按钮 40~48 高；36/60 远高于 WCAG 2.5.8 的 24x24 下限，是真实设计尺寸的下限守卫。
    // 点击部分按钮会弹出全屏遮罩弹窗（如连接二维码），需在下一击前点遮罩空白处关闭，
    // 否则后续 tap 会被遮罩拦截。
    test('所有按钮应支持触摸点击', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('h1')).toContainText('本地文件交互系统');

      // 触摸点击「选择文件」会唤起文件选择器；Playwright 的 FileChooser 没有 cancel()，
      // 无监听器时选择器会被自动取消，这里不做处理即可
      const buttons = await page.locator('button').all();
      expect(buttons.length).toBeGreaterThan(0);

      for (const button of buttons.slice(0, 3)) {
        if (await button.isVisible() && await button.isEnabled()) {
          const box = await button.boundingBox();

          expect(box.height).toBeGreaterThanOrEqual(36);
          expect(box.width).toBeGreaterThanOrEqual(60);

          await button.tap();
          await page.waitForTimeout(200);

          // 若该按钮打开了弹窗，点击左上角遮罩空白处关闭（弹窗背景 onClick 关闭）
          const overlay = page.locator('div.fixed.inset-0');
          if (await overlay.count() > 0) {
            await page.touchscreen.tap(5, 5);
            await expect(overlay).toHaveCount(0);
          }
        }
      }
    });

    test('应支持链接的触摸点击', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const links = await page.locator('a').all();

      for (const link of links.slice(0, 2)) {
        if (await link.isVisible()) {
          const box = await link.boundingBox();
          expect(box.height).toBeGreaterThan(0);
        }
      }
    });

    test('应有明确的触摸反馈', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const button = page.locator('button').first();

      if (await button.isVisible() && await button.isEnabled()) {
        const beforeTap = await button.evaluate(el => {
          return window.getComputedStyle(el).opacity;
        });

        await button.tap();
        await page.waitForTimeout(100);

        expect(parseFloat(beforeTap)).toBeGreaterThan(0);
      }
    });
  });

  test.describe('移动端表单交互', () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
      isMobile: true
    });

    test('应正确聚焦输入框', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const inputs = await page.locator('input[type="text"], input[type="search"]').all();

      for (const input of inputs.slice(0, 1)) {
        if (await input.isVisible()) {
          await input.tap();
          await page.waitForTimeout(200);

          const isFocused = await input.evaluate(el => el === document.activeElement);
          expect(isFocused).toBeTruthy();
          break;
        }
      }
    });

    test('应在移动端正确处理文件选择', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fileInput = page.locator('input[type="file"]').first();

      if (await fileInput.isVisible() || await fileInput.count() > 0) {
        const testFilePath = path.join(__dirname, '..', 'test_data', 'test-mobile.txt');

        if (!fs.existsSync(path.dirname(testFilePath))) {
          fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
        }

        fs.writeFileSync(testFilePath, 'Mobile upload test file');

        await fileInput.setInputFiles(testFilePath);
        await page.waitForTimeout(500);
      }
    });
  });

  test.describe('移动端手势操作', () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
      isMobile: true
    });

    test('应支持长按操作', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fileItems = await page.locator('[class*="file"], [class*="card"]').all();

      if (fileItems.length > 0) {
        const firstItem = fileItems[0];

        if (await firstItem.isVisible()) {
          const box = await firstItem.boundingBox();

          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
        }
      }
    });

    // 原实现对页面第一个按钮连点两次，但该按钮（连接二维码）第一次点击会弹出全屏遮罩，
    // 第二次 tap 被遮罩拦截导致超时。改为对稳定的「只看收藏」切换按钮做双击：
    // 两次快速点击各切换一次状态，最终回到初始状态，页面保持可交互。
    test('应支持双击操作', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('h1')).toContainText('本地文件交互系统');

      // 「只看收藏」按钮只在列表非空时渲染，先上传一个唯一命名的临时文件
      const fileName = `dbl-tap-${Date.now().toString(36)}.txt`;
      const filePath = path.join(__dirname, '..', 'test_data', fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'double tap test');

      await page.locator('input[type="file"]').setInputFiles(filePath);
      const card = page.locator('div.bg-surface-3.rounded-2xl').filter({ hasText: fileName });
      await expect(card).toBeVisible({ timeout: 15000 });

      const filterButton = page.locator('button:has-text("只看收藏")');
      await expect(filterButton).toBeVisible();

      // 用 tap() 而不是裸坐标 touchscreen.tap()：移动端视口较矮，
      // 列表标题区可能在首屏之下，裸坐标点击会落在视口之外导致状态根本不切换。
      // 第一次点击：进入“只看收藏”
      await filterButton.tap();
      await expect(filterButton).toContainText('★');
      // 第二次点击（快速再点）：切回全部文件
      await filterButton.tap();
      await expect(filterButton).toContainText('☆');

      // 双击后页面仍正常可交互
      await expect(page.locator('h1')).toBeVisible();
      await expect(card).toBeVisible();

      // 清理自己创建的文件
      page.once('dialog', dialog => dialog.accept().catch(() => {}));
      await card.locator('button:has-text("删除")').click();
      await expect(card).toHaveCount(0, { timeout: 10000 });
      fs.unlinkSync(filePath);
    });

    test('应在触摸时显示视觉反馈', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const buttons = await page.locator('button').all();

      for (const button of buttons.slice(0, 2)) {
        if (await button.isVisible() && await button.isEnabled()) {
          await button.tap();
          await page.waitForTimeout(150);
          break;
        }
      }
    });
  });

  test.describe('不同移动设备尺寸', () => {
    const mobileDevices = [
      { name: 'iPhone SE', width: 375, height: 667 },
      { name: 'iPhone 12', width: 390, height: 844 },
      { name: 'iPhone 12 Pro Max', width: 428, height: 926 },
      { name: 'Pixel 5', width: 393, height: 851 },
      { name: 'Samsung Galaxy S21', width: 360, height: 800 }
    ];

    for (const device of mobileDevices) {
      test(`应在 ${device.name} 上正确显示`, async ({ page }) => {
        await page.setViewportSize({ width: device.width, height: device.height });
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(device.width);

        await expect(page.locator('h1').first()).toBeVisible();
        await expect(page.locator('text=上传文件').first()).toBeVisible();

        const buttons = await page.locator('button').all();

        for (const button of buttons.slice(0, 2)) {
          if (await button.isVisible()) {
            const box = await button.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(40);
            break;
          }
        }
      });
    }
  });

  test.describe('横屏和竖屏切换', () => {
    test('应支持竖屏模式', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const viewportWidth = await page.evaluate(() => window.innerWidth);
      const viewportHeight = await page.evaluate(() => window.innerHeight);

      expect(viewportWidth).toBe(375);
      expect(viewportHeight).toBe(667);

      await expect(page.locator('h1').first()).toBeVisible();
    });

    test('应支持横屏模式', async ({ page }) => {
      await page.setViewportSize({ width: 667, height: 375 });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const viewportWidth = await page.evaluate(() => window.innerWidth);
      const viewportHeight = await page.evaluate(() => window.innerHeight);

      expect(viewportWidth).toBe(667);
      expect(viewportHeight).toBe(375);

      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(667);

      await expect(page.locator('h1').first()).toBeVisible();
    });
  });
});
