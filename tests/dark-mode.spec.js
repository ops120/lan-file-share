import { test, expect } from '@playwright/test';

/**
 * 主题测试
 *
 * 真实实现（client/src/theme.js + index.css）：
 * - 默认**白天（亮色）**主题，切换按钮在页面右上角（.theme-toggle）
 * - 切换后把 `dark` 类打到 <html> 上，选择写入 localStorage（lanShareTheme），刷新后保持
 * - 颜色全部走 CSS 变量，所以两套主题下布局完全一致（只有配色变化）
 */

const THEME_KEY = 'lanShareTheme';

// 相对亮度：>128 为亮色，<128 为暗色
function brightnessOf(color) {
  const rgb = String(color).match(/\d+/g);
  if (!rgb) return null;
  return (parseInt(rgb[0], 10) * 299 + parseInt(rgb[1], 10) * 587 + parseInt(rgb[2], 10) * 114) / 1000;
}

async function bodyBrightness(page) {
  const bg = await page.locator('body').evaluate(el => window.getComputedStyle(el).backgroundColor);
  return brightnessOf(bg);
}

async function currentTheme(page) {
  return page.evaluate(() => document.documentElement.dataset.theme);
}

test.describe('主题（白天 / 夜间）', () => {

  test.describe('默认白天主题', () => {
    test('默认应为亮色主题', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      expect(await currentTheme(page)).toBe('light');
      // 页面底色是浅色
      expect(await bodyBrightness(page)).toBeGreaterThan(128);
    });

    test('白天主题下文本应为深色且可读', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const h1Color = await page.locator('h1').first().evaluate(el => window.getComputedStyle(el).color);
      // 深色文字配浅色底
      expect(brightnessOf(h1Color)).toBeLessThan(128);

      // 正文与次要文字也应能区分（不是同一种灰到底）
      const bodyColor = await page.locator('.text-body').first().evaluate(el => window.getComputedStyle(el).color);
      const softColor = await page.locator('.text-soft').first().evaluate(el => window.getComputedStyle(el).color);
      expect(bodyColor).toBeTruthy();
      expect(softColor).toBeTruthy();
      expect(bodyColor).not.toBe(softColor);
    });

    test('白天主题下卡片与页面底色应有区分', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const pageBg = await page.locator('body').evaluate(el => window.getComputedStyle(el).backgroundColor);
      const cardBg = await page.locator('.bg-surface-2, .bg-surface-3').first()
        .evaluate(el => window.getComputedStyle(el).backgroundColor);

      expect(cardBg).toBeTruthy();
      expect(cardBg).not.toBe(pageBg);
    });

    test('白天主题下主要按钮应有对比度', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const button = page.locator('button', { hasText: '选择文件' }).first();
      const styles = await button.evaluate(el => {
        const computed = window.getComputedStyle(el);
        return { background: computed.backgroundColor, color: computed.color };
      });

      expect(styles.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(styles.color).not.toBe(styles.background);
    });
  });

  test.describe('切换到夜间主题', () => {
    test('点击切换按钮应变暗，再点回来应变亮', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      expect(await bodyBrightness(page)).toBeGreaterThan(128);

      await page.locator('.theme-toggle').click();
      await expect.poll(() => currentTheme(page)).toBe('dark');
      expect(await bodyBrightness(page)).toBeLessThan(128);

      // 夜间下标题文字应为浅色
      const h1Color = await page.locator('h1').first().evaluate(el => window.getComputedStyle(el).color);
      expect(brightnessOf(h1Color)).toBeGreaterThan(128);

      await page.locator('.theme-toggle').click();
      await expect.poll(() => currentTheme(page)).toBe('light');
      expect(await bodyBrightness(page)).toBeGreaterThan(128);
    });

    test('切换按钮文案应反映当前可切换到的主题', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const toggle = page.locator('.theme-toggle');
      await expect(toggle).toContainText('夜间');   // 当前白天 → 提示可切到夜间

      await toggle.click();
      await expect.poll(async () => (await toggle.textContent()).includes('白天')).toBe(true);
    });

    test('主题选择应写入 localStorage 并在刷新后保持', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.locator('.theme-toggle').click();
      await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), THEME_KEY)).toBe('dark');

      await page.reload();
      await page.waitForLoadState('networkidle');

      expect(await currentTheme(page)).toBe('dark');
      expect(await bodyBrightness(page)).toBeLessThan(128);
    });

    test('已存偏好为白天时首屏即为亮色', async ({ page }) => {
      // 预先写入偏好，模拟"上次选了白天"的用户
      await page.goto('/');
      await page.evaluate(key => window.localStorage.setItem(key, 'light'), THEME_KEY);
      await page.reload();
      await page.waitForLoadState('networkidle');

      expect(await currentTheme(page)).toBe('light');
      expect(await bodyBrightness(page)).toBeGreaterThan(128);
    });

    test('系统偏好为暗色也不会覆盖用户选择（默认仍是白天）', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // 主题由用户选择决定，不跟随系统偏好
      expect(await currentTheme(page)).toBe('light');
      expect(await bodyBrightness(page)).toBeGreaterThan(128);
    });
  });

  test.describe('主题切换的稳定性', () => {
    test('切换主题不应破坏布局（元素位置不变）', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const heading = page.locator('h1').first();
      const positionBefore = await heading.boundingBox();
      const cardBefore = await page.locator('.bg-surface-3').first().boundingBox();

      await page.locator('.theme-toggle').click();
      await expect.poll(() => currentTheme(page)).toBe('dark');

      const positionAfter = await heading.boundingBox();
      const cardAfter = await page.locator('.bg-surface-3').first().boundingBox();

      expect(Math.abs(positionAfter.y - positionBefore.y)).toBeLessThan(5);
      expect(Math.abs(cardAfter.height - cardBefore.height)).toBeLessThan(5);
    });

    test('切换主题后关键元素仍可见可交互', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.locator('.theme-toggle').click();
      await expect.poll(() => currentTheme(page)).toBe('dark');

      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('text=上传文件').first()).toBeVisible();
      await expect(page.locator('button', { hasText: '选择文件' })).toBeVisible();
    });

    test('两种主题下文本与背景都不相同（不会出现同色不可见）', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      for (const theme of ['light', 'dark']) {
        if (theme === 'dark') {
          await page.locator('.theme-toggle').click();
          await expect.poll(() => currentTheme(page)).toBe('dark');
        }

        const samples = await page.locator('h1, h2, p, button').all();
        for (const element of samples.slice(0, 6)) {
          if (!(await element.isVisible())) continue;

          const { color, backgroundColor } = await element.evaluate(el => {
            const computed = window.getComputedStyle(el);
            return { color: computed.color, backgroundColor: computed.backgroundColor };
          });

          if (backgroundColor === 'rgba(0, 0, 0, 0)' || backgroundColor === 'transparent') {
            continue; // 继承父级背景，由上面的 body 对比兜底
          }
          expect(color, `${theme} 主题下文字与背景不应同色`).not.toBe(backgroundColor);
        }
      }
    });

    test('图标在两种主题下都可见', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      for (const theme of ['light', 'dark']) {
        if (theme === 'dark') {
          await page.locator('.theme-toggle').click();
          await expect.poll(() => currentTheme(page)).toBe('dark');
        }

        const icons = await page.locator('svg, [class*="icon"]').all();
        for (const icon of icons.slice(0, 3)) {
          if (await icon.isVisible()) {
            const opacity = await icon.evaluate(el => window.getComputedStyle(el).opacity);
            expect(parseFloat(opacity)).toBeGreaterThan(0);
            break;
          }
        }
      }
    });
  });

  test.describe('跨设备主题一致性', () => {
    const devices = [
      { width: 1920, height: 1080, name: 'desktop' },
      { width: 768, height: 1024, name: 'tablet' },
      { width: 375, height: 667, name: 'mobile' }
    ];

    for (const device of devices) {
      test(`${device.name} 上默认白天主题且可切换`, async ({ page }) => {
        await page.setViewportSize({ width: device.width, height: device.height });
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        expect(await currentTheme(page)).toBe('light');
        expect(await bodyBrightness(page)).toBeGreaterThan(128);

        await page.locator('.theme-toggle').click();
        await expect.poll(() => currentTheme(page)).toBe('dark');
        expect(await bodyBrightness(page)).toBeLessThan(128);
      });
    }
  });
});
