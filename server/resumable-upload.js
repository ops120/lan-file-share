/**
 * ⚠️ 参考草稿，不可直接运行 —— 本文件不是可加载的模块，也未被任何代码引用。
 *
 * 断点续传的正式实现见 server/server.js 中的：
 *   - GET  /api/upload/status/:filename
 *   - POST /api/upload/chunk
 * 本文件是设计初稿片段，直接引用了 server.js 作用域内的 app / db / UPLOAD_DIR / nanoid，
 * 单独运行会立即抛 ReferenceError；其广播消息类型 fileUploaded 与正式实现的 file_uploaded 也不一致。
 * 保留仅供历史参考，请勿在此基础上另行挂载。
 */

// 断点续传支持 - 检查文件上传状态
app.get('/api/upload/status/:filename', (req, res) => {
  const filename = req.params.filename;
  const tempPath = path.join(UPLOAD_DIR, '.temp', filename);
  const tempDir = path.join(UPLOAD_DIR, '.temp');

  // 检查完整文件是否已存在
  if (fs.existsSync(tempPath)) {
    const stat = fs.statSync(tempPath);
    res.json({
      uploaded: true,
      size: stat.size
    });
    return;
  }

  // 扫描已上传的分块
  const uploadedChunks = [];
  let totalSize = 0;

  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    const chunkPattern = new RegExp(`^${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.part(\\d+)$`);

    files.forEach(file => {
      const match = file.match(chunkPattern);
      if (match) {
        const chunkIndex = parseInt(match[1]);
        uploadedChunks.push(chunkIndex);

        const chunkPath = path.join(tempDir, file);
        const stat = fs.statSync(chunkPath);
        totalSize += stat.size;
      }
    });
  }

  // 排序分块索引
  uploadedChunks.sort((a, b) => a - b);

  res.json({
    uploaded: false,
    uploadedChunks,
    chunkCount: uploadedChunks.length,
    totalSize
  });
});

// 断点续传 - 分块上传
app.post('/api/upload/chunk', express.raw({type: 'application/octet-stream', limit: '100mb'}), (req, res) => {
  try {
    const { filename, chunkIndex, totalChunks, fileId } = req.query;

    if (!filename || !chunkIndex || !totalChunks) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    const tempDir = path.join(UPLOAD_DIR, '.temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const chunkPath = path.join(tempDir, `${filename}.part${chunkIndex}`);
    fs.writeFileSync(chunkPath, req.body);

    // 检查是否所有分块都已上传
    const uploadedChunks = [];
    for (let i = 0; i < parseInt(totalChunks); i++) {
      const partPath = path.join(tempDir, `${filename}.part${i}`);
      if (fs.existsSync(partPath)) {
        uploadedChunks.push(i);
      }
    }

    // 如果所有分块都已上传，合并文件
    if (uploadedChunks.length === parseInt(totalChunks)) {
      const finalPath = path.join(UPLOAD_DIR, filename);
      const writeStream = fs.createWriteStream(finalPath);

      for (let i = 0; i < parseInt(totalChunks); i++) {
        const partPath = path.join(tempDir, `${filename}.part${i}`);
        const data = fs.readFileSync(partPath);
        writeStream.write(data);
        fs.unlinkSync(partPath); // 删除分块
      }

      writeStream.end();

      writeStream.on('finish', () => {
        const stat = fs.statSync(finalPath);
        const id = fileId || nanoid(10);
        const now = Date.now();

        // 保存到数据库
        db.run(`
          INSERT INTO files (id, filename, size, mime_type, storage_path, upload_time, expire_time, upload_device, is_favorite, deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        `, [id, filename, stat.size, 'application/octet-stream', filename, now, now + 24 * 60 * 60 * 1000, 'unknown']);

        saveDatabase();

        // 广播更新
        broadcast({
          type: 'fileUploaded',
          file: {
            id,
            filename,
            size: stat.size,
            upload_time: now
          }
        });

        res.json({
          success: true,
          fileId: id,
          filename,
          size: stat.size,
          message: '文件上传完成'
        });
      });
    } else {
      res.json({
        success: true,
        uploaded: uploadedChunks.length,
        total: parseInt(totalChunks),
        message: `已上传 ${uploadedChunks.length}/${totalChunks} 个分块`
      });
    }
  } catch (error) {
    console.error('分块上传失败:', error);
    res.status(500).json({ error: error.message });
  }
});
