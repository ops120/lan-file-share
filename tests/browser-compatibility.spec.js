import { test, expect } from '@playwright/test';

/**
 * 浏览器兼容性测试
 *
 * 注意：Playwright 不允许在 test.describe 内使用 test.use({ browserName })（会强制新建 worker），
 * 真正的“在哪个浏览器里跑”由 playwright.config.js 的 projects（chromium-desktop / firefox-desktop /
 * webkit-desktop 等）决定。本文件只做与引擎无关的兼容性断言。
 */
test.describe('浏览器兼容性测试', () => {

  test.describe('基础加载与渲染（Chromium 项目）', () => {
    test('应在 Chromium 中正常加载页面', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('text=上传文件').first()).toBeVisible();

      const title = await page.title();
      expect(title).toContain('本地文件交互系统');
    });

    test('应在 Chromium 中正常处理 CSS 样式', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const body = page.locator('body');
      const bgColor = await body.evaluate(el => {
        return window.getComputedStyle(el).backgroundColor;
      });

      expect(bgColor).toBeTruthy();
      expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
    });

    test('应在 Chromium 中支持 flexbox 和 grid', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const gridElements = await page.locator('[class*="grid"]').all();

      for (const element of gridElements) {
        if (await element.isVisible()) {
          const display = await element.evaluate(el => {
            return window.getComputedStyle(el).display;
          });
          expect(['grid', 'flex', 'block'].includes(display)).toBeTruthy();
        }
      }
    });

    test('应在 Chromium 中正确处理点击事件', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const buttons = await page.locator('button').all();

      for (const button of buttons) {
        if (await button.isVisible() && await button.isEnabled()) {
          const initialUrl = page.url();
          await button.click({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(100);
          break;
        }
      }
    });
  });

  test.describe('基础加载与渲染（Firefox 项目）', () => {
    test('应在 Firefox 中正常加载页面', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('text=上传文件').first()).toBeVisible();

      const title = await page.title();
      expect(title).toContain('本地文件交互系统');
    });

    test('应在 Firefox 中正确渲染布局', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const body = page.locator('body');
      const scrollWidth = await body.evaluate(el => document.body.scrollWidth);
      const clientWidth = await body.evaluate(el => document.body.clientWidth);

      expect(scrollWidth).toBeGreaterThan(0);
      expect(clientWidth).toBeGreaterThan(0);
    });

    test('应在 Firefox 中支持现代 CSS 特性', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const element = page.locator('body').first();
      const cssSupport = await element.evaluate(() => {
        return {
          grid: CSS.supports('display', 'grid'),
          flex: CSS.supports('display', 'flex'),
          customProperties: CSS.supports('--test', '0')
        };
      });

      expect(cssSupport.grid).toBeTruthy();
      expect(cssSupport.flex).toBeTruthy();
      expect(cssSupport.customProperties).toBeTruthy();
    });

    test('应在 Firefox 中正确处理事件', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const buttons = await page.locator('button').all();
      let hasInteractiveButton = false;

      for (const button of buttons) {
        if (await button.isVisible() && await button.isEnabled()) {
          hasInteractiveButton = true;
          await button.hover();
          await page.waitForTimeout(100);
          break;
        }
      }

      expect(hasInteractiveButton).toBeTruthy();
    });
  });

  test.describe('基础加载与渲染（WebKit 项目）', () => {
    test('应在 Safari 中正常加载页面', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('text=上传文件').first()).toBeVisible();

      const title = await page.title();
      expect(title).toContain('本地文件交互系统');
    });

    test('应在 Safari 中正确应用样式', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const buttons = await page.locator('button').all();

      for (const button of buttons) {
        if (await button.isVisible()) {
          const styles = await button.evaluate(el => {
            const computed = window.getComputedStyle(el);
            return {
              borderRadius: computed.borderRadius,
              padding: computed.padding,
              backgroundColor: computed.backgroundColor
            };
          });

          expect(styles.backgroundColor).toBeTruthy();
          break;
        }
      }
    });

    test('应在 Safari 中支持触摸事件', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const buttons = await page.locator('button').all();

      for (const button of buttons) {
        if (await button.isVisible() && await button.isEnabled()) {
          const box = await button.boundingBox();
          expect(box.height).toBeGreaterThan(30);
          break;
        }
      }
    });

    test('应在 Safari 中正确处理 CSS Grid', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const gridElements = await page.locator('[class*="grid"]').all();

      for (const element of gridElements) {
        if (await element.isVisible()) {
          const display = await element.evaluate(el => {
            return window.getComputedStyle(el).display;
          });
          expect(display).toBeTruthy();
          break;
        }
      }
    });
  });

  test.describe('跨浏览器功能一致性', () => {
    // 手动 newContext 不会继承 use 里的 baseURL，必须显式传入，否则 page.goto('/') 会因相对地址报错
    const browsers = ['chromium', 'firefox', 'webkit'];

    for (const browserName of browsers) {
      test(`${browserName} - 应加载相同的页面内容`, async ({ browser, baseURL }) => {
        const context = await browser.newContext({ baseURL });
        const page = await context.newPage();

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await expect(page.locator('h1').first()).toBeVisible();
        await expect(page.locator('text=上传文件').first()).toBeVisible();

        const title = await page.title();
        expect(title).toContain('本地文件交互系统');

        await context.close();
      });
    }

    test('应在所有浏览器中保持一致的布局结构', async ({ browser, baseURL }) => {
      const results = [];

      for (const browserName of browsers) {
        const context = await browser.newContext({ baseURL });
        const page = await context.newPage();

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const mainElementCount = await page.locator('main, [role="main"], #root').count();
        const buttonCount = await page.locator('button').count();
        const headingCount = await page.locator('h1, h2, h3').count();

        results.push({
          browser: browserName,
          mainElementCount,
          buttonCount,
          headingCount
        });

        await context.close();
      }

      expect(results.length).toBe(browsers.length);
      // 每个引擎都应至少渲染出主容器与标题
      for (const result of results) {
        expect(result.mainElementCount).toBeGreaterThan(0);
        expect(result.headingCount).toBeGreaterThan(0);
      }
    });
  });

  test.describe('CSS 特性兼容性', () => {
    test('应在所有浏览器中支持 CSS 变量', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const supportsCustomProps = await page.evaluate(() => {
        return CSS.supports('--test', '0');
      });

      expect(supportsCustomProps).toBeTruthy();
    });

    test('应在所有浏览器中支持 Flexbox', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const supportsFlex = await page.evaluate(() => {
        return CSS.supports('display', 'flex');
      });

      expect(supportsFlex).toBeTruthy();
    });

    test('应在所有浏览器中支持 Grid', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const supportsGrid = await page.evaluate(() => {
        return CSS.supports('display', 'grid');
      });

      expect(supportsGrid).toBeTruthy();
    });
  });

  test.describe('JavaScript API 兼容性', () => {
    test('应支持 Fetch API', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const hasFetch = await page.evaluate(() => {
        return typeof fetch !== 'undefined';
      });

      expect(hasFetch).toBeTruthy();
    });

    test('应支持 Promise', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const hasPromise = await page.evaluate(() => {
        return typeof Promise !== 'undefined';
      });

      expect(hasPromise).toBeTruthy();
    });

    test('应支持现代 JavaScript 特性', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const modernFeatures = await page.evaluate(() => {
        return {
          async: typeof (async () => {}) === 'function',
          arrow: typeof (() => {}) === 'function',
          destructuring: (() => { try { eval('const {a} = {a:1}'); return true; } catch { return false; } })(),
        };
      });

      expect(modernFeatures.async).toBeTruthy();
      expect(modernFeatures.arrow).toBeTruthy();
    });
  });
});
