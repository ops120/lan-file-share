/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}"
  ],
  // 用 <html class="dark"> 切换夜间主题（默认白天/亮色）
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 全部指向 CSS 变量（见 src/index.css），换主题无需改组件
        surface: {
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          4: 'var(--surface-4)',
          5: 'var(--surface-5)'
        },
        accent: 'var(--accent)',
        'accent-muted': 'var(--accent-muted)',
        // 语义文本色：strong（标题）/ body（正文）/ soft（次要）/ faint（更弱）
        strong: 'var(--text-strong)',
        body: 'var(--text-body)',
        soft: 'var(--text-soft)',
        faint: 'var(--text-faint)',
        overlay: 'var(--overlay)'
      }
    }
  },
  plugins: []
}
