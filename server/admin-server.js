import express from 'express';
import path from 'path';
import fs from 'fs';
import { APP_ROOT, CONFIG_FILE, DEFAULT_UPLOAD_DIR, ADMIN_DIR } from './paths.js';

const app = express();

// 管理接口只接受 JSON，且不开启 CORS：
// 否则本机浏览器里打开的任意网页都能用「简单表单 POST」打到 127.0.0.1 的后台，
// 静默批量删除文件甚至改写 config.json（CSRF）。
app.use(express.json());

// 跨站来源直接拒绝（管理后台页面与其 API 同源，同源请求不带 Origin 或带本机 Origin）
function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const { hostname, port } = new URL(origin);
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    return isLocalHost && (!port || Number(port) === currentAdminPort || Number(port) === mainServicePort);
  } catch (error) {
    return false;
  }
}

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return next();
  }
  if (!isTrustedOrigin(req)) {
    return res.status(403).json({ success: false, error: '来源不被信任' });
  }
  next();
});

// 默认配置
const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: 8080,
  uploadDir: DEFAULT_UPLOAD_DIR,
  maxFileSize: 1024 * 1024 * 1024, // 1GB
  autoCleanHours: 24
};

// 读取配置
async function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}

// 保存配置
async function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 管理后台不直接读写数据库：主服务用 sql.js 把整个数据库驻留在内存里，
 * 并在每次写操作后把内存快照覆盖回 database.db。若这里另开一个连接改文件，
 * 主服务的下一次保存就会把这些改动全部覆盖掉（后台删掉的文件会“复活”）。
 * 因此所有数据操作都转发给主服务的 HTTP 接口，由主服务单点写入。
 *
 * 转发端口必须用主服务「启动时」的端口：后台改端口只写进 config.json，
 * 要重启才生效，若这里改用磁盘上的新端口，会立刻 502。
 */
let mainServicePort = DEFAULT_CONFIG.port;
let currentAdminPort = DEFAULT_CONFIG.port + 1;

function mainServerUrl(urlPath) {
  return `http://127.0.0.1:${mainServicePort}${urlPath}`;
}

async function callMainServer(urlPath, options = {}) {
  const response = await fetch(mainServerUrl(urlPath), {
    ...options,
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // 主服务可能返回非 JSON（如下载页 HTML），此处按无 JSON 处理
  }

  return { ok: response.ok, status: response.status, json };
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

// 统计上传目录的实际磁盘占用
function calcDiskUsage(uploadDir) {
  let diskUsage = 0;
  try {
    if (fs.existsSync(uploadDir)) {
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const fullPath = path.join(dir, name);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else {
            diskUsage += stat.size;
          }
        }
      };
      walk(uploadDir);
    }
  } catch (error) {
    // 目录不存在或无法访问
  }
  return diskUsage;
}

// 获取系统状态
app.get('/api/admin/status', async (req, res) => {
  try {
    const config = await loadConfig();

    let fileCount = 0;
    let totalSize = 0;

    const { ok, json } = await callMainServer('/api/files');
    if (ok && Array.isArray(json)) {
      fileCount = json.length;
      totalSize = json.reduce((sum, file) => sum + (file.size || 0), 0);
    }

    res.json({
      success: true,
      fileCount,
      totalSize,
      diskUsage: calcDiskUsage(config.uploadDir),
      serverPort: config.port,
      config
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取配置
app.get('/api/admin/config', async (req, res) => {
  try {
    const config = await loadConfig();
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新配置
app.post('/api/admin/config', async (req, res) => {
  try {
    const currentConfig = await loadConfig();
    const newConfig = { ...currentConfig, ...req.body };

    // 验证配置
    if (!Number.isInteger(newConfig.port) || newConfig.port < 1 || newConfig.port > 65535) {
      return res.status(400).json({ success: false, error: '端口号必须在 1-65535 之间' });
    }

    if (!Number.isFinite(newConfig.maxFileSize) || newConfig.maxFileSize < 1024 * 1024) {
      return res.status(400).json({ success: false, error: '最大文件大小不能小于 1MB' });
    }

    if (!Number.isFinite(newConfig.autoCleanHours) || newConfig.autoCleanHours < 1) {
      return res.status(400).json({ success: false, error: '自动清理时间至少为 1 小时' });
    }

    // 检查上传目录是否存在，不存在则创建
    if (newConfig.uploadDir !== currentConfig.uploadDir) {
      try {
        if (!fs.existsSync(newConfig.uploadDir)) {
          fs.mkdirSync(newConfig.uploadDir, { recursive: true });
        }
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: `无法创建上传目录: ${error.message}`
        });
      }
    }

    await saveConfig(newConfig);

    res.json({
      success: true,
      config: newConfig,
      message: '配置已保存，需要重启服务器才能生效'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取文件列表（返回数组，与管理后台前端约定一致）
app.get('/api/admin/files', async (req, res) => {
  try {
    const config = await loadConfig();
    const { ok, json } = await callMainServer('/api/files');

    if (!ok || !Array.isArray(json)) {
      return res.status(502).json({ success: false, error: '主服务不可用，无法获取文件列表' });
    }

    res.json(json);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 批量删除文件（转发给主服务，避免绕过主服务的数据库副本）
app.post('/api/admin/files/delete-batch', async (req, res) => {
  try {
    const { fileIds } = req.body;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ success: false, error: '请提供要删除的文件 ID 列表' });
    }

    const config = await loadConfig();
    let deleted = 0;
    let failed = 0;

    for (const id of fileIds) {
      try {
        const { ok } = await callMainServer(`/api/files/${encodeURIComponent(id)}`, {
          method: 'DELETE'
        });
        if (ok) {
          deleted++;
        } else {
          failed++;
        }
      } catch (error) {
        failed++;
      }
    }

    res.json({
      success: true,
      deleted,
      failed,
      message: `成功删除 ${deleted} 个文件，失败 ${failed} 个`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 清理过期文件（转发给主服务，由主服务统一执行清理逻辑）
app.post('/api/admin/cleanup', async (req, res) => {
  try {
    const config = await loadConfig();
    const { ok, json } = await callMainServer('/api/admin/cleanup', { method: 'POST' });

    if (!ok || !json) {
      return res.status(502).json({ success: false, error: '主服务不可用，无法执行清理' });
    }

    res.json({
      success: true,
      deleted: json.deleted || 0,
      failed: 0,
      message: `清理完成：删除 ${json.deleted || 0} 个过期文件`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 提供管理后台前端
app.use(express.static(ADMIN_DIR));

// 未命中的 API 路径返回 JSON 404，避免被下面的兜底路由吞成 HTML
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: '接口不存在' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

// 启动服务器
export function startAdminServer(port, config) {
  const adminPort = port; // 接收的 port 参数已经是管理后台端口

  // 主服务实际监听的端口来自启动时的配置，之后后台改端口只写文件、需重启才生效
  currentAdminPort = adminPort;
  mainServicePort = (config && config.port) || adminPort - 1;

  const adminServer = app.listen(adminPort, '127.0.0.1', () => {
    console.log('');
    console.log('🔧 管理后台已启动');
    console.log(`📡 后台地址: http://localhost:${adminPort}`);
    console.log('⚠️  仅本机可访问（127.0.0.1）');
    console.log('');
  });

  // 端口被占用（例如主服务已自动拉起过管理后台）时给出提示而不是崩溃
  adminServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`⚠️  管理后台端口 ${adminPort} 已被占用，可能已由主服务启动`);
    } else {
      console.warn('⚠️  管理后台启动失败:', error.message);
    }
  });

  return adminServer;
}

// 直接用 node admin-server.js 单独启动管理后台时（npm run admin）才自启；
// 被 server.js 引用、或打包进 exe 时（argv[1] 是可执行文件路径）都不走这里。
const invokedDirectly = typeof process.argv[1] === 'string'
  && process.argv[1].split(path.sep).pop() === 'admin-server.js';

if (invokedDirectly) {
  // 用 Promise 而不是顶层 await：打包成 CJS 单文件时不支持顶层 await
  loadConfig().then((config) => startAdminServer(config.port + 1, config));
}
