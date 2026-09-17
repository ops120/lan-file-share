/**
 * 主题（白天 / 夜间）
 *
 * 由 <html> 上的 `dark` 类驱动：index.css 里两套 CSS 变量都挂在它下面，
 * 组件只使用语义色，所以切换主题不需要改任何组件代码。
 * 选择结果记在 localStorage，刷新与重开都保持。
 */

const STORAGE_KEY = 'lanShareTheme';

// 默认白天
export const DEFAULT_THEME = 'light';

export function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      return stored;
    }
  } catch (error) {
    // 隐私模式等场景下 localStorage 不可用，回落到默认值
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  // 便于调试与自动化测试断言当前主题
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
}

export function storeTheme(theme) {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch (error) {
    // 存不了也不影响本次会话使用
  }
}

/** 在首屏渲染前调用，避免刷新时先闪一下另一套主题 */
export function initTheme() {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
}
