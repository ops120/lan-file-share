import { defineConfig, devices } from '@playwright/test';

/**
 * 完整的 Playwright 测试配置
 * 支持多浏览器、多设备、失败重试、报告生成
 */
export default defineConfig({
  // 测试目录（本地 .tests/，不入库；发布包为纯源码）
  testDir: './.tests',

  // 全量收尾：清理测试用例上传到真实 uploads 目录的测试文件
  // （含 100MB 级大文件用例，不做清理会逐轮累积）
  globalTeardown: './.tests/global-teardown.js',

  // 全局超时设置
  timeout: 120000, // 单个测试 120 秒
  expect: {
    timeout: 10000, // 断言超时 10 秒
  },

  // 测试执行配置
  fullyParallel: false, // 顺序执行，避免端口冲突
  forbidOnly: !!process.env.CI, // CI 环境禁止 .only
  retries: process.env.CI ? 2 : 1, // 失败重试：CI 环境 2 次，本地 1 次
  workers: process.env.CI ? 1 : 1, // 并发数：避免资源竞争

  // 测试报告
  reporter: [
    ['html', { outputFolder: 'tmp/playwright-report', open: 'never' }],
    ['json', { outputFile: 'tmp/test-results/results.json' }],
    ['junit', { outputFile: 'tmp/test-results/junit.xml' }],
    ['list'], // 控制台输出
  ],

  // 全局配置
  use: {
    // 基础 URL
    baseURL: 'http://localhost:13080',

    // 浏览器行为
    headless: true, // 无头模式
    screenshot: 'only-on-failure', // 失败时截图
    // trace/video 只在「首次重试」时录制：'retain-on-failure' 会对每个用例全程录制，
    // 在 Windows 上高频 reload 场景偶发 teardown 归档 ENOENT（表现为用例 flaky），
    // 且显著拖慢整轮执行。改为 on-first-retry 后失败用例仍有完整 trace 可查。
    video: 'on-first-retry',
    trace: 'on-first-retry',

    // 视口和用户代理
    viewport: { width: 1920, height: 1080 },

    // 超时设置
    actionTimeout: 15000, // 操作超时
    navigationTimeout: 30000, // 导航超时

    // 忽略 HTTPS 错误
    ignoreHTTPSErrors: true,

    // 浏览器上下文
    permissions: [], // 默认无权限
    geolocation: undefined,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },

  // 多项目配置：不同浏览器和设备
  projects: [
    // ============ 桌面浏览器 ============
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: 'firefox-desktop',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: 'webkit-desktop',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // ============ 平板设备 ============
    {
      name: 'ipad',
      use: {
        ...devices['iPad Pro'],
      },
    },
    {
      name: 'tablet-android',
      use: {
        ...devices['Galaxy Tab S4'],
      },
    },

    // ============ 移动设备 ============
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
      },
    },
    {
      name: 'mobile-android',
      use: {
        ...devices['Pixel 5'],
      },
    },
  ],

  // Web 服务器配置
  // 测试直接跑在 Express 上（13080 端口同时托管 client/dist 静态产物与 API），
  // 因此先构建前端再启动服务，避免测到过期的 dist 产物。
  // 管理后台由 server.js 自动在 PORT+1（13081）启动，无需单独拉起，重复拉起会端口冲突。
  webServer: [
    {
      command: 'npm run build && npm start',
      url: 'http://localhost:13080/api/info',
      timeout: 180000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],

  // 输出目录
  outputDir: 'tmp/test-results/',
});
