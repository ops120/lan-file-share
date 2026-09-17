import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initTheme } from './theme';
import './index.css';

// 渲染前先把主题类打到 <html> 上，避免刷新时闪一下另一套配色
initTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
