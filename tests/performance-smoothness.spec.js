import { test, expect } from '@playwright/test';

test.describe('页面性能和流畅性测试', () => {

  test.describe('页面加载性能', () => {
    test('应快速加载首页', async ({ page }) => {
      const startTime = Date.now();

      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      const loadTime = Date.now() - startTime;

      expect(loadTime).toBeLessThan(3000);

      await expect(page.locator('h1').first()).toBeVisible();
    });

    test('应在网络空闲后快速完成渲染', async ({ page }) => {
      const startTime = Date.now();

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fullLoadTime = Date.now() - startTime;

      expect(fullLoadTime).toBeLessThan(5000);
    });

    // 原实现紧跟 goto 立刻读 paint 条目，此时 FCP 往往还没产生，拿到 0 被误判失败。
    // 改为 web-first 轮询等待 FCP 条目出现（性能预算 2s 不变）。
    test('应快速显示首屏内容', async ({ page }) => {
      await page.goto('/');

      await expect
        .poll(() => page.evaluate(() => {
          const paintEntries = performance.getEntriesByType('paint');
          const fcp = paintEntries.find(entry => entry.name === 'first-contentful-paint');
          return fcp ? fcp.startTime : 0;
        }), { timeout: 10000 })
        .toBeGreaterThan(0);

      const firstPaint = await page.evaluate(() => {
        const paintEntries = performance.getEntriesByType('paint');
        const fcp = paintEntries.find(entry => entry.name === 'first-contentful-paint');
        return fcp.startTime;
      });

      expect(firstPaint).toBeLessThan(2000);
    });
  });

  test.describe('滚动流畅性', () => {
    test('应保持流畅的滚动性能', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const scrollMetrics = await page.evaluate(() => {
        return new Promise((resolve) => {
          let frameCount = 0;
          let startTime = performance.now();
          const frameTimes = [];

          function measureFrame() {
            frameCount++;
            const currentTime = performance.now();
            frameTimes.push(currentTime - startTime);
            startTime = currentTime;

            if (frameCount < 30) {
              requestAnimationFrame(measureFrame);
            } else {
              const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
              const fps = 1000 / avgFrameTime;
              resolve({ fps, avgFrameTime });
            }
          }

          window.scrollTo(0, 100);
          requestAnimationFrame(measureFrame);
        });
      });

      expect(scrollMetrics.fps).toBeGreaterThan(30);
    });

    test('滚动时应没有明显的卡顿', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 100));
        await page.waitForTimeout(50);
      }

      const scrollTop = await page.evaluate(() => window.scrollY);
      expect(scrollTop).toBeGreaterThan(0);
    });

    test('快速滚动应保持响应', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      await page.waitForTimeout(300);

      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });

      await page.waitForTimeout(300);

      const finalScrollTop = await page.evaluate(() => window.scrollY);
      expect(finalScrollTop).toBe(0);
    });
  });

  test.describe('交互响应性', () => {
    test('按钮点击应即时响应', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const target = page.locator('button', { hasText: '显示连接二维码' }).first();
      await expect(target).toBeVisible();

      // 不直接给 locator.click() 计时：Playwright 的点击包含可操作性检查、滚动与失败重试，
      // 高负载下实测抖动到 100~210ms，测到的是驱动开销而不是应用响应性。
      // 这里在页面内测量「点击 → 事件处理完成」的主线程耗时，并断言应用确实产生了可见响应。
      const dispatchLatency = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
          .find(b => b.textContent.includes('显示连接二维码'));
        const start = performance.now();
        button.click();
        return performance.now() - start;
      });

      // 同步事件派发超过 100ms 说明主线程被阻塞
      expect(dispatchLatency).toBeLessThan(100);

      // 应用确实响应了点击（弹出扫码连接弹窗），而不是点了没反应
      await expect(page.locator('h3', { hasText: '扫码连接' })).toBeVisible();

      // 关闭弹窗，避免影响后续用例
      await page.locator('button', { hasText: '关闭' }).click();
      await expect(page.locator('h3', { hasText: '扫码连接' })).toBeHidden();
    });

    test('hover 效果应流畅显示', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const buttons = await page.locator('button').all();

      for (const button of buttons.slice(0, 3)) {
        if (await button.isVisible()) {
          await button.hover();
          await page.waitForTimeout(50);
        }
      }
    });

    test('应快速响应键盘输入', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const input = page.locator('input[type="text"], input[type="search"]').first();

      if (await input.isVisible()) {
        await input.click();

        const startTime = Date.now();
        await input.type('test');
        const typingTime = Date.now() - startTime;

        expect(typingTime).toBeLessThan(500);

        const value = await input.inputValue();
        expect(value).toContain('test');
      }
    });
  });

  test.describe('动画和过渡', () => {
    test('CSS 过渡应流畅执行', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const button = page.locator('button').first();

      if (await button.isVisible()) {
        const hasTransition = await button.evaluate(el => {
          const styles = window.getComputedStyle(el);
          return styles.transition !== 'all 0s ease 0s';
        });

        if (hasTransition) {
          await button.hover();
          await page.waitForTimeout(300);
        }
      }
    });

    test('页面加载动画应正确完成', async ({ page }) => {
      await page.goto('/');

      await page.waitForLoadState('networkidle');

      const loadingIndicators = await page.locator('[class*="loading"], [class*="spinner"]').all();

      for (const indicator of loadingIndicators) {
        const isVisible = await indicator.isVisible();
        if (isVisible) {
          await page.waitForTimeout(1000);
        }
      }
    });
  });

  test.describe('资源加载优化', () => {
    test('应正确加载所有关键资源', async ({ page }) => {
      const responses = [];

      page.on('response', response => {
        responses.push({
          url: response.url(),
          status: response.status(),
          type: response.request().resourceType()
        });
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const failedResources = responses.filter(r => r.status >= 400);
      expect(failedResources.length).toBe(0);
    });

    test('图片应正确加载', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const images = await page.locator('img').all();

      for (const img of images) {
        if (await img.isVisible()) {
          const naturalWidth = await img.evaluate(el => el.naturalWidth);
          expect(naturalWidth).toBeGreaterThan(0);
        }
      }
    });

    // 真实实现只使用系统字体栈（index.css 的 --font-body/--font-mono），
    // 没有 @font-face，因此 FontFaceSet 的 size 恒为 0（实测），用 size>0 断言是错的。
    // 真实可验证的行为：字体集就绪（status 为 loaded），且正文解析出了可用字体族，
    // 页面文本以该字体族实际渲染。
    test('字体应正确加载', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('h1').first()).toBeVisible();

      const fontInfo = await page.evaluate(async () => {
        await document.fonts.ready;
        return {
          status: document.fonts.status,
          bodyFontFamily: window.getComputedStyle(document.body).fontFamily,
          h1RenderedFont: document.fonts.check(
            `16px ${window.getComputedStyle(document.querySelector('h1')).fontFamily.split(',')[0]}`
          )
        };
      });

      expect(fontInfo.status).toBe('loaded');
      expect(fontInfo.bodyFontFamily.trim().length).toBeGreaterThan(0);
      expect(fontInfo.h1RenderedFont).toBeTruthy();
    });
  });

  test.describe('内存使用', () => {
    test('页面应正常管理内存', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 100));
        await page.waitForTimeout(100);
      }

      await page.evaluate(() => {
        if (window.gc) {
          window.gc();
        }
      });

      await page.waitForTimeout(500);

      await expect(page.locator('h1').first()).toBeVisible();
    });
  });

  test.describe('不同网络条件', () => {
    test('应在快速网络下快速加载', async ({ page, context }) => {
      await context.route('**/*', route => route.continue());

      const startTime = Date.now();
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      const loadTime = Date.now() - startTime;

      expect(loadTime).toBeLessThan(2000);
    });

    test('应处理慢速网络连接', async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

      await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('并发操作', () => {
    test('应处理多个同时交互', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const buttons = await page.locator('button').all();

      if (buttons.length >= 2) {
        await Promise.all([
          buttons[0].isVisible() ? buttons[0].hover() : Promise.resolve(),
          buttons[1].isVisible() ? buttons[1].hover() : Promise.resolve()
        ]);

        await page.waitForTimeout(200);
      }
    });

    test('应处理快速连续点击', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const button = page.locator('button').first();

      if (await button.isVisible() && await button.isEnabled()) {
        for (let i = 0; i < 3; i++) {
          await button.click({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(100);
        }
      }
    });
  });

  test.describe('页面稳定性', () => {
    test('应没有布局偏移', async ({ page }) => {
      await page.goto('/');

      const initialLayout = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return h1 ? h1.getBoundingClientRect().top : 0;
      });

      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      const finalLayout = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return h1 ? h1.getBoundingClientRect().top : 0;
      });

      const layoutShift = Math.abs(finalLayout - initialLayout);
      expect(layoutShift).toBeLessThan(50);
    });

    test('页面元素应保持稳定位置', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const button = page.locator('button').first();

      if (await button.isVisible()) {
        const pos1 = await button.boundingBox();

        await page.waitForTimeout(1000);

        const pos2 = await button.boundingBox();

        expect(Math.abs(pos1.y - pos2.y)).toBeLessThan(5);
        expect(Math.abs(pos1.x - pos2.x)).toBeLessThan(5);
      }
    });
  });
});
