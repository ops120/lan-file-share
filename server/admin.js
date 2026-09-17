/**
 * ⚠️ 已废弃（DEPRECATED）—— 未被任何代码引用，请勿接入。
 *
 * 管理后台接口由 server/admin-server.js 提供，本文件是早期基于 better-sqlite3 的实现，保留仅供历史参考：
 *  1. 依赖 better-sqlite3，但该依赖未在 server/package.json 中声明，安装后也无法运行；
 *  2. 使用 CommonJS（require），而 server/package.json 声明了 "type": "module"，无法被 import；
 *  3. 读取 data/files.db，实际数据库是 data/database.db；
 *  4. 使用 files.stored_filename 列，实际列名是 storage_path。
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const Database = require('better-sqlite3');

const adminRouter = express.Router();

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// 默认配置
const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: 8080,
  uploadDir: path.join(__dirname, '..', 'uploads'),
  maxFileSize: 1024 * 1024 * 1024, // 1GB
  autoCleanHours: 24
};

// 读取配置
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}

// 保存配置
async function saveConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 获取系统状态
adminRouter.get('/api/admin/status', async (req, res) => {
  try {
    const config = await loadConfig();
    const dbPath = path.join(__dirname, '..', 'data', 'files.db');
    const db = new Database(dbPath);

    const fileCount = db.prepare('SELECT COUNT(*) as count FROM files').get().count;
    const totalSize = db.prepare('SELECT SUM(size) as total FROM files').get().total || 0;

    db.close();

    // 获取上传目录大小
    let diskUsage = 0;
    try {
      const files = await fs.readdir(config.uploadDir);
      for (const file of files) {
        const stat = await fs.stat(path.join(config.uploadDir, file));
        diskUsage += stat.size;
      }
    } catch (error) {
      // 目录不存在或无法访问
    }

    res.json({
      success: true,
      status: {
        fileCount,
        totalSize,
        diskUsage,
        config
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取配置
adminRouter.get('/api/admin/config', async (req, res) => {
  try {
    const config = await loadConfig();
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新配置
adminRouter.post('/api/admin/config', async (req, res) => {
  try {
    const currentConfig = await loadConfig();
    const newConfig = { ...currentConfig, ...req.body };

    // 验证配置
    if (newConfig.port < 1 || newConfig.port > 65535) {
      return res.status(400).json({ success: false, error: '端口号必须在 1-65535 之间' });
    }

    if (newConfig.maxFileSize < 1024 * 1024) {
      return res.status(400).json({ success: false, error: '最大文件大小不能小于 1MB' });
    }

    // 检查上传目录是否存在，不存在则创建
    if (newConfig.uploadDir !== currentConfig.uploadDir) {
      try {
        await fs.mkdir(newConfig.uploadDir, { recursive: true });
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

// 获取文件列表（管理后台专用，包含更多信息）
adminRouter.get('/api/admin/files', (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', 'data', 'files.db');
    const db = new Database(dbPath);

    const files = db.prepare(`
      SELECT * FROM files
      ORDER BY upload_time DESC
    `).all();

    db.close();

    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 批量删除文件
adminRouter.post('/api/admin/files/delete-batch', async (req, res) => {
  try {
    const { fileIds } = req.body;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ success: false, error: '请提供要删除的文件 ID 列表' });
    }

    const config = await loadConfig();
    const dbPath = path.join(__dirname, '..', 'data', 'files.db');
    const db = new Database(dbPath);

    let deleted = 0;
    let failed = 0;

    for (const id of fileIds) {
      try {
        const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);

        if (file) {
          const filePath = path.join(config.uploadDir, file.stored_filename);
          try {
            await fs.unlink(filePath);
          } catch (error) {
            // 文件可能已被删除
          }

          db.prepare('DELETE FROM files WHERE id = ?').run(id);
          deleted++;
        }
      } catch (error) {
        failed++;
      }
    }

    db.close();

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

// 清理过期文件
adminRouter.post('/api/admin/cleanup', async (req, res) => {
  try {
    const config = await loadConfig();
    const dbPath = path.join(__dirname, '..', 'data', 'files.db');
    const db = new Database(dbPath);

    const expireTime = Date.now() - (config.autoCleanHours * 60 * 60 * 1000);

    const expiredFiles = db.prepare('SELECT * FROM files WHERE upload_time < ?').all(expireTime);

    let deleted = 0;
    let failed = 0;

    for (const file of expiredFiles) {
      try {
        const filePath = path.join(config.uploadDir, file.stored_filename);
        await fs.unlink(filePath);
        db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
        deleted++;
      } catch (error) {
        failed++;
      }
    }

    db.close();

    res.json({
      success: true,
      deleted,
      failed,
      message: `清理完成：删除 ${deleted} 个过期文件，失败 ${failed} 个`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { adminRouter, loadConfig, saveConfig };
