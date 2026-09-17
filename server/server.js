import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import initSqlJs from 'sql.js';
import Bonjour from 'bonjour-service';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'os';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { startAdminServer } from './admin-server.js';
import {
  APP_ROOT,
  CONFIG_FILE,
  DATA_DIR,
  DEFAULT_UPLOAD_DIR,
  WEB_DIR,
  ADMIN_DIR,
  SQL_WASM_PATH,
  IS_PACKAGED,
  APP_VERSION
} from './paths.js';

// 加载配置
let CONFIG = {
  host: '0.0.0.0',
  port: 8080,
  uploadDir: DEFAULT_UPLOAD_DIR,
  maxFileSize: 1024 * 1024 * 1024, // 1GB
  autoCleanHours: 24
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    CONFIG = { ...CONFIG, ...configData };
  } catch (error) {
    console.warn('⚠️  加载配置文件失败，使用默认配置');
  }
}

const app = express();
const PORT = CONFIG.port;

// 创建必要目录
// uploadDir 允许写相对路径：相对的是数据根目录（开发时=仓库根目录，exe 时=exe 所在目录），
// 而不是进程的工作目录——否则从别处启动 exe 会把文件写到意外的地方
const UPLOAD_DIR = path.isAbsolute(CONFIG.uploadDir)
  ? CONFIG.uploadDir
  : path.join(APP_ROOT, CONFIG.uploadDir);
const DB_PATH = path.join(DATA_DIR, 'database.db');
const DB_BACKUP_PATH = `${DB_PATH}.bak`;
const DB_TEMP_PATH = `${DB_PATH}.tmp`;

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 数据库所在目录不存在时也要建，否则首次部署写入会直接 ENOENT
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// 数据库：由 initDatabase() 异步初始化（不能放顶层 await —— 打包成 CJS 单文件时不支持）
let db;
let SQL;

/**
 * 加载数据库。saveDatabase 采用 tmp+rename，理论上不会留下半截文件；
 * 但仍兼容进程被强杀等极端情况：损坏时回退到上一次的 .bak，避免服务彻底起不来。
 */
function loadDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    return new SQL.Database();
  }

  try {
    return new SQL.Database(fs.readFileSync(DB_PATH));
  } catch (error) {
    console.error('⚠️  数据库文件损坏，尝试从备份恢复:', error.message);

    if (fs.existsSync(DB_BACKUP_PATH)) {
      const corrupted = `${DB_PATH}.corrupted-${Date.now()}`;
      try {
        fs.renameSync(DB_PATH, corrupted);
        const restored = new SQL.Database(fs.readFileSync(DB_BACKUP_PATH));
        fs.copyFileSync(DB_BACKUP_PATH, DB_PATH);
        console.error(`⚠️  已回退到备份，损坏文件保留为 ${path.basename(corrupted)}`);
        return restored;
      } catch (restoreError) {
        console.error('⚠️  备份恢复失败:', restoreError.message);
      }
    }

    throw error;
  }
}

/** 建表（首次运行或换新库时） */
function createSchema() {
  db.run(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT,
    storage_path TEXT NOT NULL,
    upload_time INTEGER NOT NULL,
    expire_time INTEGER,
    upload_device TEXT,
    is_favorite INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0
  )
`);

  db.run(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    is_self INTEGER DEFAULT 0
  )
`);

  db.run(`
  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    file_id TEXT,
    action TEXT,
    device_id TEXT,
    timestamp INTEGER
  )
`);
}

/**
 * 初始化 sql.js 与数据库。
 * 打包成 exe 后 wasm 文件是从 exe 内解出来的，必须显式告知路径；
 * 开发模式下留空，交给 sql.js 自己在 node_modules 里查找。
 */
async function initDatabase() {
  const options = SQL_WASM_PATH && fs.existsSync(SQL_WASM_PATH)
    ? { wasmBinary: fs.readFileSync(SQL_WASM_PATH) }
    : {};

  SQL = await initSqlJs(options);
  db = loadDatabase();
  createSchema();
}

// 持久化数据库：先写临时文件再原子替换，避免写一半被中断留下损坏的 database.db
let dbSaveFailed = false;

function saveDatabase() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_TEMP_PATH, data);

    // 每次保存前把当前库复制为备份，确保 .bak 始终是「上一版成功落库的数据」。
    // 原写法只在首次写入时建一次 .bak、之后永不刷新，一旦库文件损坏，恢复会丢掉首次之后全部记录。
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, DB_BACKUP_PATH);
    }

    fs.renameSync(DB_TEMP_PATH, DB_PATH);
    dbSaveFailed = false;
  } catch (error) {
    if (!dbSaveFailed) {
      console.error('❌ 数据库保存失败（数据仍保留在内存中）:', error.message);
      dbSaveFailed = true;
    }
  }
}

// multipart 里的文件名由 busboy 按 latin1 解码，中文会变成乱码，需要按 UTF-8 重解
function decodeFilename(name) {
  if (!name || typeof name !== 'string') return name;
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  // 若重解后出现替换字符，说明原始串本就是合法的 UTF-8 文本，保持原样
  return utf8.includes('\uFFFD') ? name : utf8;
}

// 只允许纯文件名，杜绝 ../、绝对路径、空字节等穿越手段
function safeBaseName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const base = path.basename(trimmed.replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return null;
  if (base.includes('/') || base.includes('\\')) return null;
  return base;
}

// 严格模式：要求传入值本身就是纯文件名，出现路径分隔符直接判定为非法（而不是悄悄归一化）
function strictBaseName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  return trimmed;
}

// Content-Disposition 需要同时给出 ASCII 回退名与 RFC 5987 的 UTF-8 名
// attachment 用于下载；inline 用于在线预览（浏览器对内联媒体才会播放，attachment 会强制下载）
function contentDisposition(filename, type = 'attachment') {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// 获取本机IP
/**
 * 收集本机所有可用于访问服务的 IPv4 地址。
 * 一台机器常见多个网卡（有线/无线/虚拟网卡/VPN），不同设备能连通的网段可能不同，
 * 因此这里全部返回、按「更适合局域网访问」排序，由使用者在界面上自行选择。
 */
function getAllLocalIPs() {
  const candidates = [];

  for (const [name, nets] of Object.entries(networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // 169.254.x.x 是链路本地地址，正常网络下不可达
      if (/^169\.254\./.test(net.address)) continue;
      candidates.push({ ip: net.address, interface: name });
    }
  }

  // 排序权重：家庭/办公常用私网段优先，198.18/16（部分 VPN、基准测试网段）最后
  const rank = (ip) => {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    if (/^198\.18\./.test(ip)) return 9;
    return 5;
  };

  candidates.sort((a, b) => rank(a.ip) - rank(b.ip));

  return candidates.map((candidate, index) => ({
    ...candidate,
    url: `http://${candidate.ip}:${CONFIG.port}`,
    // 排序后的第一个作为默认推荐地址
    recommended: index === 0
  }));
}

// 当前用于生成二维码/展示的地址（默认是排序后的推荐地址）
function getLocalIP() {
  const [first] = getAllLocalIPs();
  return first ? first.ip : '127.0.0.1';
}

// config.json 里写死的 host 换网络后会失效，这里校验它是否仍属于本机网卡；
// 不在本机就退回自动探测，避免二维码指向打不开的地址。
function resolveLocalIP() {
  const configured = CONFIG.host;
  if (configured && configured !== '0.0.0.0') {
    const owned = Object.values(networkInterfaces())
      .flat()
      .some(net => net && net.family === 'IPv4' && net.address === configured);

    if (owned) {
      return configured;
    }

    console.warn(`⚠️  config.json 中的 host ${configured} 不属于本机网卡，已自动改用探测到的局域网地址`);
  }
  return getLocalIP();
}

const LOCAL_IP = resolveLocalIP();

/**
 * 解析请求方指定的地址。
 * 只接受「本机真实拥有的 IP」，避免把 host 参数变成任意跳转：
 * 传了非法值就回退到默认地址，而不是照单全收。
 */
function resolveRequestedIP(requested) {
  if (typeof requested !== 'string' || !requested.trim()) {
    return LOCAL_IP;
  }

  const wanted = requested.trim();
  const owned = getAllLocalIPs().map(item => item.ip);

  return owned.includes(wanted) ? wanted : LOCAL_IP;
}

// 中间件
// 同源部署（前端由本服务托管）不需要 CORS；这里只放行本机与局域网私有网段来源，
// 避免局域网里任意网页对服务发起跨源请求读取文件清单或删文件。
const PRIVATE_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

app.use(cors({
  origin(origin, callback) {
    // 没有 Origin 头的请求（同源导航、curl、服务端调用）直接放行
    if (!origin || PRIVATE_ORIGIN.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  }
}));
// 写操作同源校验。仅靠 CORS 不够：CORS 只阻止浏览器读取响应，不阻止请求被执行，
// 跨站页面仍可静默完成上传/删除（已实测：带外部 Origin 的 POST /api/upload 返回 200 success=true）。
// 同源请求不带 Origin、或带的 Origin 指向本服务自身，才允许状态变更。
// 注意：必须放在 express.json() 之前，否则已被 body-parser 消费过的请求体无法回退。
function isOwnOrigin(origin) {
  if (!origin) return true; // 同源浏览器导航 / 非浏览器客户端（curl、Playwright request fixture）
  try {
    const { hostname, port } = new URL(origin);
    if (port && port !== String(PORT) && port !== String(PORT + 1)) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    return getAllLocalIPs().some(item => item.ip === hostname);
  } catch (error) {
    return false;
  }
}
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (isOwnOrigin(req.headers.origin)) return next();
  console.warn(`⚠️  拒绝跨站状态变更: ${req.method} ${req.url} Origin=${req.headers.origin}`);
  return res.status(403).json({ error: '跨站来源不被信任，已拒绝该状态变更请求' });
});
app.use(express.json());
app.use(express.static(WEB_DIR));

// 文件上传配置
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = nanoid(10);
    // 统一按 UTF-8 还原文件名，后续入库也使用这个已还原的名字
    file.originalname = decodeFilename(file.originalname);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    const storedName = `${id}_${name}${ext}`;

    // 立刻记录已落盘的文件：请求中断时 multer 不会设置 req.files，
    // 只有在这里记账才能在后续把半截文件回收掉
    if (!req.__uploadedPaths) {
      req.__uploadedPaths = [];
    }
    req.__uploadedPaths.push(path.join(UPLOAD_DIR, storedName));

    cb(null, storedName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: CONFIG.maxFileSize }
});

/**
 * 回收中断上传留下的半截文件。
 * 客户端取消上传/切换页面断开连接时，multer 可能已经把部分内容写进 uploads，
 * 而这类文件没有数据库记录，不主动删除就会永久占用磁盘。
 * 判定依据：响应没有正常写完（writableEnded 为 false）即视为请求失败。
 */
app.use((req, res, next) => {
  const cleanupInterruptedUpload = () => {
    if (res.writableEnded) {
      return;
    }

    const paths = new Set(req.__uploadedPaths || []);
    if (req.file && req.file.path) {
      paths.add(req.file.path);
    }
    if (Array.isArray(req.files)) {
      req.files.forEach(file => file && file.path && paths.add(file.path));
    }

    for (const filePath of paths) {
      fs.promises.unlink(filePath).catch(() => {});
    }
  };

  res.on('close', cleanupInterruptedUpload);
  req.on('aborted', cleanupInterruptedUpload);

  next();
});

// WebSocket 服务
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  clients.add(ws);

  // ws 实例出错若无人监听会抛出未处理异常，直接拖垮进程
  ws.on('error', (error) => {
    console.warn('WebSocket 连接异常:', error.message);
    clients.delete(ws);
  });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
});

// 心跳：清掉手机切后台等原因形成的半开连接，避免 broadcast 持续写死连接、连接集合无限增长
const WS_HEARTBEAT_MS = 30000;
setInterval(() => {
  clients.forEach((ws) => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      clients.delete(ws);
    }
  });
}, WS_HEARTBEAT_MS);

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// API 路由

// 获取服务信息
app.get('/api/info', (req, res) => {
  const addresses = getAllLocalIPs();

  res.json({
    ip: LOCAL_IP,
    port: PORT,
    url: `http://${LOCAL_IP}:${PORT}`,
    // 多网卡时把全部可用地址交给前端，由使用者选择手机能连通的那个
    addresses,
    maxFileSize: CONFIG.maxFileSize,
    autoCleanHours: CONFIG.autoCleanHours
  });
});

// 获取文件列表
app.get('/api/files', (req, res) => {
  // 先把直接放进上传目录的文件登记进来，这样"拷进去就能在页面上看到"
  importUntrackedFilesThrottled();

  const result = db.exec(`
    SELECT * FROM files
    WHERE deleted = 0
    ORDER BY upload_time DESC
  `);

  const files = result.length > 0 ? result[0].values.map(row => ({
    id: row[0],
    filename: row[1],
    size: row[2],
    mime_type: row[3],
    storage_path: row[4],
    upload_time: row[5],
    expire_time: row[6],
    upload_device: row[7],
    is_favorite: row[8],
    deleted: row[9]
  })) : [];

  res.json(files);
});

// 上传文件
app.post('/api/upload', upload.array('files', 50), (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: '未收到任何文件' });
  }
  const uploadDevice = req.body.device || 'unknown';
  const now = Date.now();
  const expireTime = now + CONFIG.autoCleanHours * 60 * 60 * 1000;

  const uploadedFiles = files.map(file => {
    const id = nanoid(10);

    db.run(
      `INSERT INTO files (id, filename, size, mime_type, storage_path, upload_time, expire_time, upload_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, file.originalname, file.size, file.mimetype, file.filename, now, expireTime, uploadDevice]
    );

    return {
      id,
      filename: file.originalname,
      size: file.size,
      mime_type: file.mimetype,
      upload_time: now
    };
  });

  saveDatabase();
  broadcast({ type: 'file_uploaded', files: uploadedFiles });

  res.json({ success: true, files: uploadedFiles });
});

/**
 * 按需把文件流式发给客户端，支持 HTTP Range（下载断点续传与视频拖动进度都依赖它）。
 * disposition 为 attachment 时是下载，为 inline 时供浏览器内联播放/预览。
 */
function streamStoredFile(req, res, file, disposition = 'attachment') {
  const filePath = path.join(UPLOAD_DIR, file.storage_path);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const fileSize = fs.statSync(filePath).size;
  const contentType = file.mime_type || 'application/octet-stream';
  const range = req.headers.range;

  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // 禁止浏览器嗅探类型：避免把伪装成文本的上传文件当 HTML 执行
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(file.filename, disposition)
  };

  const sendFile = (status, headers, streamOptions) => {
    res.writeHead(status, headers);
    const stream = fs.createReadStream(filePath, streamOptions);
    // 流出错（并发清理删掉了文件、磁盘异常等）时要主动断开响应，否则连接悬挂
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  // 支持 Range 请求（断点续传 / 视频拖动进度）
  if (range && /^bytes=/.test(range)) {
    const spec = range.replace(/^bytes=/, '').trim();

    // 多区间请求本实现不支持，按规范忽略 Range 返回完整内容
    if (spec.includes(',')) {
      return sendFile(200, { ...baseHeaders, 'Content-Length': fileSize });
    }

    const [rawStart, rawEnd] = spec.split('-');
    let start;
    let end;

    if (rawStart === '') {
      // 后缀区间：bytes=-500 表示最后 500 字节
      const suffixLength = parseInt(rawEnd, 10);
      if (Number.isNaN(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }
      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    } else {
      start = parseInt(rawStart, 10);
      end = rawEnd ? parseInt(rawEnd, 10) : fileSize - 1;
    }

    if (Number.isNaN(start) || start < 0 || start >= fileSize || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const safeEnd = Math.min(end, fileSize - 1);

    return sendFile(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${safeEnd}/${fileSize}`,
      'Content-Length': (safeEnd - start) + 1
    }, { start, end: safeEnd });
  }

  // 完整内容
  sendFile(200, { ...baseHeaders, 'Content-Length': fileSize });
}

// 按 id 取文件记录（排除已删除）
function findActiveFile(id) {
  const result = db.exec('SELECT * FROM files WHERE id = ? AND deleted = 0', [id]);

  if (result.length === 0 || result[0].values.length === 0) {
    return null;
  }

  const row = result[0].values[0];
  return {
    id: row[0],
    filename: row[1],
    size: row[2],
    mime_type: row[3],
    storage_path: row[4]
  };
}

// 下载文件（支持断点续传）
app.get('/api/download/:id', (req, res) => {
  const file = findActiveFile(req.params.id);

  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  streamStoredFile(req, res, file, 'attachment');
});

// 在线预览（inline，视频/图片/音频/PDF 可直接在页面里播放或查看，同样支持 Range 拖动进度）
app.get('/api/preview/:id', (req, res) => {
  const file = findActiveFile(req.params.id);

  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  streamStoredFile(req, res, file, 'inline');
});

// 更新文件（重新上传替换）
app.put('/api/files/:id', upload.single('file'), (req, res) => {
  const { id } = req.params;
  const result = db.exec('SELECT storage_path FROM files WHERE id = ? AND deleted = 0', [id]);

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }

  // 更新数据库记录（先落库成功再删旧文件，避免中途失败导致 DB 指向已删除的文件）
  const file = req.file;
  const now = Date.now();
  const expireTime = now + CONFIG.autoCleanHours * 60 * 60 * 1000;
  const oldStoragePath = result[0].values[0][0];

  db.run(
    `UPDATE files SET
      filename = ?, size = ?, mime_type = ?, storage_path = ?, upload_time = ?, expire_time = ?
     WHERE id = ?`,
    [file.originalname, file.size, file.mimetype, file.filename, now, expireTime, id]
  );

  saveDatabase();

  // 旧文件在新记录落库后再清理，删不掉也不会造成数据不一致
  if (oldStoragePath && oldStoragePath !== file.filename) {
    const oldFilePath = path.join(UPLOAD_DIR, oldStoragePath);
    try {
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    } catch (error) {
      console.warn('旧文件清理失败:', error.message);
    }
  }

  broadcast({ type: 'file_updated', file: { id, filename: file.originalname } });

  res.json({ success: true, file: { id, filename: file.originalname, size: file.size } });
});

// 断点续传 - 检查上传状态
app.get('/api/upload/status/:filename', (req, res) => {
  const filename = strictBaseName(req.params.filename);
  if (!filename) {
    return res.status(400).json({ error: '非法的文件名' });
  }

  const tempDir = path.join(UPLOAD_DIR, '.temp');
  const tempPath = path.join(tempDir, filename);

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

// 分块总量上限，避免构造超大循环拖垮服务
const MAX_TOTAL_CHUNKS = 20000;

// 正在合并的文件名集合，防止同一文件的多个"最后一块"并发合并出重复记录
const mergingFiles = new Set();

// 计算文件 SHA-256（流式，避免大文件一次性读入内存）
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// 顺序流式合并分块，避免一次性把整包读进内存
async function mergeChunks(tempDir, filename, total, finalPath) {
  const out = fs.createWriteStream(finalPath);
  try {
    for (let i = 0; i < total; i++) {
      await pipeline(
        fs.createReadStream(path.join(tempDir, `${filename}.part${i}`)),
        out,
        { end: false }
      );
    }
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.on('finish', resolve);
      out.end();
    });
  } catch (error) {
    out.destroy();
    throw error;
  }
}

// 断点续传 - 分块上传
app.post('/api/upload/chunk', express.raw({type: 'application/octet-stream', limit: '100mb'}), async (req, res) => {
  try {
    const { filename: rawFilename, chunkIndex, totalChunks, originalName, mimeType, fileHash } = req.query;

    // 文件名必须收敛为纯文件名，否则 ../ 可以写出上传目录之外
    const filename = strictBaseName(rawFilename);
    if (!filename) {
      return res.status(400).json({ error: '非法的文件名' });
    }

    // 可选的整文件 SHA-256 校验值（hex），用于合并后验证内容完整性
    const expectedHash = typeof fileHash === 'string' && /^[a-fA-F0-9]{64}$/.test(fileHash)
      ? fileHash
      : null;
    if (fileHash && !expectedHash) {
      return res.status(400).json({ error: 'fileHash 必须是 64 位十六进制 SHA-256' });
    }

    const chunkIdx = Number.parseInt(chunkIndex, 10);
    const total = Number.parseInt(totalChunks, 10);
    if (!Number.isInteger(chunkIdx) || !Number.isInteger(total) ||
        chunkIdx < 0 || total < 1 || chunkIdx >= total || total > MAX_TOTAL_CHUNKS) {
      return res.status(400).json({ error: '缺少或非法的分块参数' });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: '分块内容为空' });
    }

    const tempDir = path.join(UPLOAD_DIR, '.temp');
    await fs.promises.mkdir(tempDir, { recursive: true });

    const partPath = (i) => path.join(tempDir, `${filename}.part${i}`);
    await fs.promises.writeFile(partPath(chunkIdx), req.body);

    // 一次 readdir 判断分块是否齐全，避免按 totalChunks 逐次 stat 造成系统调用放大
    const existingParts = new Set(fs.readdirSync(tempDir));
    let uploadedCount = 0;
    for (let i = 0; i < total; i++) {
      if (existingParts.has(`${filename}.part${i}`)) {
        uploadedCount++;
      }
    }

    // 分块未齐，等待后续分块
    if (uploadedCount !== total) {
      return res.json({
        success: true,
        uploaded: uploadedCount,
        total,
        message: `已上传 ${uploadedCount}/${total} 个分块`
      });
    }

    // 同一文件名的最后一块并发到达时，只允许一个请求执行合并，避免重复入库
    if (mergingFiles.has(filename)) {
      return res.status(409).json({ error: '该文件正在合并中，请稍后重试' });
    }
    mergingFiles.add(filename);

    // 分块齐全，合并成最终文件
    const providedName = safeBaseName(originalName) || filename;
    const ext = path.extname(providedName);
    const baseName = path.basename(providedName, ext);
    const id = nanoid(10);
    const finalFileName = `${id}_${baseName}${ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalFileName);

    try {
      await mergeChunks(tempDir, filename, total, finalPath);

      // 客户端若提供整文件 SHA-256，合并后校验，不一致则丢弃并报错
      if (expectedHash) {
        const actualHash = await sha256File(finalPath);
        if (actualHash !== expectedHash.toLowerCase()) {
          await fs.promises.unlink(finalPath).catch(() => {});
          return res.status(422).json({
            error: '文件校验失败，哈希与客户端声明不一致',
            expected: expectedHash.toLowerCase(),
            actual: actualHash
          });
        }
      }
    } catch (error) {
      await fs.promises.unlink(finalPath).catch(() => {});
      throw error;
    } finally {
      mergingFiles.delete(filename);
    }

    // 合并成功后再清理分块
    await Promise.all(
      Array.from({ length: total }, (_, i) => fs.promises.unlink(partPath(i)).catch(() => {}))
    );

    const stat = await fs.promises.stat(finalPath);
    const now = Date.now();
    const expireTime = now + CONFIG.autoCleanHours * 60 * 60 * 1000;
    const displayName = decodeFilename(providedName);

    db.run(`
      INSERT INTO files (id, filename, size, mime_type, storage_path, upload_time, expire_time, upload_device)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, displayName, stat.size, mimeType || 'application/octet-stream', finalFileName, now, expireTime, 'unknown']);

    saveDatabase();

    broadcast({
      type: 'file_uploaded',
      files: [{
        id,
        filename: displayName,
        size: stat.size,
        upload_time: now
      }]
    });

    res.json({
      success: true,
      files: [{
        id,
        filename: displayName,
        size: stat.size,
        mime_type: mimeType || 'application/octet-stream',
        upload_time: now
      }],
      message: '文件上传完成'
    });
  } catch (error) {
    console.error('分块上传失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 删除文件
app.delete('/api/files/:id', (req, res) => {
  const { id } = req.params;
  const result = db.exec('SELECT storage_path, deleted FROM files WHERE id = ?', [id]);

  // 从未存在过的 id 明确返回 404，避免管理后台批量删除把失败计成成功
  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  const [storagePath, alreadyDeleted] = result[0].values[0];

  // 重复删除按幂等处理，但不重复计数
  if (Number(alreadyDeleted) === 1) {
    return res.json({ success: true, alreadyDeleted: true });
  }

  const filePath = path.join(UPLOAD_DIR, storagePath);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    // 文件被占用（正在下载）时无法立即删除，仍标记删除并交由后续清理
    console.warn('文件删除失败，已标记待清理:', error.message);
  }

  db.run('UPDATE files SET deleted = 1 WHERE id = ?', [id]);
  saveDatabase();

  broadcast({ type: 'file_deleted', fileId: id });

  res.json({ success: true });
});

// HTML 转义，防止文件名里的脚本被下载页原样渲染
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

// 收藏 / 取消收藏：POST /api/files/:id/favorite 为切换，也支持显式 { favorite: true|false }
app.post('/api/files/:id/favorite', (req, res) => {
  const { id } = req.params;
  const result = db.exec('SELECT is_favorite FROM files WHERE id = ? AND deleted = 0', [id]);

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  const current = Number(result[0].values[0][0]) === 1;
  const next = typeof req.body?.favorite === 'boolean' ? req.body.favorite : !current;

  db.run('UPDATE files SET is_favorite = ? WHERE id = ?', [next ? 1 : 0, id]);
  saveDatabase();

  broadcast({ type: 'file_favorite', fileId: id, isFavorite: next });

  res.json({ success: true, id, is_favorite: next ? 1 : 0 });
});

// 取消收藏（显式 DELETE 语义）
app.delete('/api/files/:id/favorite', (req, res) => {
  const { id } = req.params;
  const result = db.exec('SELECT is_favorite FROM files WHERE id = ? AND deleted = 0', [id]);

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  db.run('UPDATE files SET is_favorite = 0 WHERE id = ?', [id]);
  saveDatabase();

  broadcast({ type: 'file_favorite', fileId: id, isFavorite: false });

  res.json({ success: true, id, is_favorite: 0 });
});

// 生成文件二维码
app.get('/api/qrcode/:id', async (req, res) => {
  const { id } = req.params;
  // 允许客户端指定用哪个本机地址生成二维码（多网卡/多网段场景），非本机地址会被忽略
  const host = resolveRequestedIP(req.query.host);
  const url = `http://${host}:${PORT}/download/${id}`;

  try {
    const qrcode = await QRCode.toDataURL(url, { width: 300 });
    res.json({ qrcode, url, host });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// 生成服务连接二维码
app.get('/api/connect-qrcode', async (req, res) => {
  const host = resolveRequestedIP(req.query.host);
  const url = `http://${host}:${PORT}`;

  try {
    const qrcode = await QRCode.toDataURL(url, { width: 300 });
    res.json({ qrcode, url, host });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// 下载页面（移动端扫码直接下载）
app.get('/download/:id', (req, res) => {
  const { id } = req.params;
  const result = db.exec('SELECT * FROM files WHERE id = ? AND deleted = 0', [id]);

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).send('File not found');
  }

  const row = result[0].values[0];
  const file = {
    filename: row[1],
    size: row[2]
  };

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>下载文件</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          margin: 0;
          padding: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          background: #0A0D12;
          color: #E5E7EB;
        }
        .container {
          text-align: center;
          max-width: 400px;
        }
        .icon {
          font-size: 64px;
          margin-bottom: 20px;
        }
        h1 {
          font-size: 20px;
          margin: 0 0 10px;
          color: #F9FAFB;
        }
        .size {
          color: #9CA3AF;
          margin: 0 0 30px;
        }
        button {
          background: #38BDF8;
          color: #0A0D12;
          border: none;
          padding: 16px 32px;
          font-size: 16px;
          font-weight: 600;
          border-radius: 999px;
          cursor: pointer;
          width: 100%;
        }
        button:hover {
          background: #0EA5E9;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">📄</div>
        <h1>${escapeHtml(file.filename)}</h1>
        <p class="size">${(file.size / 1024 / 1024).toFixed(2)} MB</p>
        <button onclick="download()">立即下载</button>
      </div>
      <script>
        function download() {
          window.location.href = '/api/download/${encodeURIComponent(id)}';
        }
      </script>
    </body>
    </html>
  `);
});

// 常见扩展名到 MIME 的映射：直接放进上传目录的文件没有 multer 提供的类型，需要自己判断
const MIME_BY_EXT = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.avif': 'image/avif', '.tiff': 'image/tiff', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.ogv': 'video/ogg', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.3gp': 'video/3gpp', '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive'
};

function lookupMimeType(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

/**
 * 把「直接放进上传目录」的文件纳入管理。
 * 使用者经常直接把文件拷进 uploads/（或用同步工具放进来），这些文件没有数据库记录，
 * 既不显示在列表里，还会被当作孤儿文件清掉——这里主动登记它们。
 *
 * 判定"写入已完成"用两个信号，避免把正在拷贝/正在上传的半成品登记进来：
 *  a) 文件已经很旧（1 分钟内没有写入）——启动扫描时用，历史文件立即登记；
 *  b) 连续两次扫描体积不变（且 2 秒内无写入）——刚放进来的文件用，通常在 5~10 秒内可见。
 */
const importCandidates = new Map(); // 文件名 -> 上一轮扫描时的体积

function importUntrackedFiles() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    return 0;
  }

  const known = new Set();
  const rows = db.exec('SELECT storage_path FROM files');
  if (rows.length > 0) {
    rows[0].values.forEach(row => known.add(row[0]));
  }

  const now = Date.now();
  const seen = new Map();
  let imported = 0;

  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (name.startsWith('.') || known.has(name)) {
      continue;
    }

    const filePath = path.join(UPLOAD_DIR, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    seen.set(name, stat.size);

    const ageMs = now - stat.mtimeMs;
    const definitelyComplete = ageMs > 60 * 1000;
    const stableAcrossScans = importCandidates.get(name) === stat.size;

    if (ageMs <= 2000 || (!definitelyComplete && !stableAcrossScans)) {
      continue;
    }

    // 经本服务上传的文件名形如 <id>_原名，展示时去掉内部前缀
    const displayName = name.replace(/^[A-Za-z0-9_-]{10}_/, '') || name;

    db.run(
      `INSERT INTO files (id, filename, size, mime_type, storage_path, upload_time, expire_time, upload_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nanoid(10),
        displayName,
        stat.size,
        lookupMimeType(displayName),
        name,
        stat.mtimeMs,
        // 放进来的文件同样适用过期策略，但给足一个完整周期
        now + CONFIG.autoCleanHours * 60 * 60 * 1000,
        'manual-import'
      ]
    );
    imported++;
  }

  importCandidates.clear();
  seen.forEach((size, name) => importCandidates.set(name, size));

  if (imported > 0) {
    saveDatabase();
    console.log(`Imported ${imported} file(s) placed directly in the upload directory`);
    // 让已连接的页面刷新列表
    broadcast({ type: 'file_uploaded', files: [] });
  }

  return imported;
}

// 列表接口的扫描节流：最多每 5 秒扫一次上传目录，兼顾"放进文件马上能看到"与开销
const IMPORT_SCAN_INTERVAL_MS = 5000;
let lastImportScanAt = 0;

function importUntrackedFilesThrottled() {
  const now = Date.now();
  if (now - lastImportScanAt < IMPORT_SCAN_INTERVAL_MS) {
    return 0;
  }
  lastImportScanAt = now;

  try {
    return importUntrackedFiles();
  } catch (error) {
    console.warn('扫描上传目录失败:', error.message);
    return 0;
  }
}

// 定期清理过期文件与残留分块
function cleanupExpiredFiles() {
  const now = Date.now();

  // 先登记直接放进上传目录的文件，避免它们被当成孤儿文件清掉
  try {
    importUntrackedFiles();
  } catch (error) {
    console.warn('扫描上传目录失败:', error.message);
  }

  // 收藏表示"长期保存"，不参与过期清理
  const result = db.exec(
    'SELECT id, storage_path FROM files WHERE expire_time < ? AND deleted = 0 AND is_favorite = 0',
    [now]
  );

  let expiredCount = 0;
  let failedCount = 0;

  if (result.length > 0 && result[0].values.length > 0) {
    result[0].values.forEach(row => {
      const fileId = row[0];
      const storagePath = row[1];
      const filePath = path.join(UPLOAD_DIR, storagePath);

      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        db.run('UPDATE files SET deleted = 1 WHERE id = ?', [fileId]);
        expiredCount++;
      } catch (error) {
        // Windows 下文件被下载流占用会抛 EBUSY/EPERM：
        // 这里必须逐个兜住，否则定时器里的异常会直接终止进程
        console.warn(`过期文件清理失败（下轮重试）: ${storagePath} - ${error.message}`);
        failedCount++;
      }
    });

    if (expiredCount > 0) {
      saveDatabase();
      console.log(`Cleaned ${expiredCount} expired files${failedCount ? `, ${failedCount} failed` : ''}`);
    }
  }

  // 定期清退软删除记录，避免数据库只增不减（每次落盘都是全量导出）
  const purgeBefore = now - 7 * 24 * 60 * 60 * 1000;
  try {
    db.run('DELETE FROM files WHERE deleted = 1 AND upload_time < ?', [purgeBefore]);
  } catch (error) {
    console.warn('历史记录清退失败:', error.message);
  }

  // 清理长期未完成的分块上传，避免 .temp 无限增长
  const tempDir = path.join(UPLOAD_DIR, '.temp');
  let removedChunks = 0;
  if (fs.existsSync(tempDir)) {
    const staleBefore = now - CONFIG.autoCleanHours * 60 * 60 * 1000;
    for (const name of fs.readdirSync(tempDir)) {
      const partPath = path.join(tempDir, name);
      try {
        if (fs.statSync(partPath).mtimeMs < staleBefore) {
          fs.unlinkSync(partPath);
          removedChunks++;
        }
      } catch (error) {
        // 文件可能已被并发清理
      }
    }
    if (removedChunks > 0) {
      console.log(`Cleaned ${removedChunks} stale upload chunks`);
    }
  }

  // 兜底清理磁盘上的无用文件：
  //  a) 没有任何数据库记录的文件（历史上被中断的上传，正常已在请求中断时即时回收）
  //  b) 数据库里已标记删除、但删除时 unlink 失败（如文件被占用）而残留下来的文件
  // 保留 1 小时宽限期，避免删掉正在写入或正在下载的文件；deleted=0 的活动文件永不清理。
  let removedOrphans = 0;
  try {
    const live = new Set();
    const softDeleted = new Set();

    const rows = db.exec('SELECT storage_path, deleted FROM files');
    if (rows.length > 0) {
      rows[0].values.forEach(row => {
        if (Number(row[1]) === 1) {
          softDeleted.add(row[0]);
        } else {
          live.add(row[0]);
        }
      });
    }

    const graceMs = 60 * 60 * 1000;
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      if (name.startsWith('.')) continue;
      if (live.has(name)) continue;

      const filePath = path.join(UPLOAD_DIR, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.mtimeMs > now - graceMs) continue;
        fs.unlinkSync(filePath);
        removedOrphans++;
      } catch (error) {
        // 并发删除等情况忽略
      }
    }

    if (removedOrphans > 0) {
      console.log(`Cleaned ${removedOrphans} orphaned upload files`);
    }
  } catch (error) {
    console.warn('孤儿文件清理失败:', error.message);
  }

  return { expiredCount, removedChunks, removedOrphans };
}

// 清理定时器由 main() 里的 startCleanupTimer() 启动（见下方），
// 这里不再模块级注册——否则会与 startCleanupTimer 并发出多个每小时巡检。

// 仅允许本机回环地址调用的管理接口
function isLoopbackRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// 手动触发清理（供管理后台调用；管理后台运行在本机且只监听 127.0.0.1）
app.post('/api/admin/cleanup', (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ success: false, error: '仅允许本机访问' });
  }

  try {
    const { expiredCount, removedChunks } = cleanupExpiredFiles();
    res.json({
      success: true,
      deleted: expiredCount,
      removedChunks,
      message: `清理完成：删除 ${expiredCount} 个过期文件，清理 ${removedChunks} 个残留分块`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 上传体积超限等错误统一转为 JSON
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      error: error.code === 'LIMIT_FILE_SIZE' ? '文件超过大小限制' : `上传失败: ${error.message}`
    });
  }
  // express.raw / express.json 的体积超限走的是 body-parser 的 413
  if (error.type === 'entity.too.large' || error.status === 413) {
    return res.status(413).json({ error: '请求体超过大小限制' });
  }
  if (error) {
    console.error('请求处理失败:', error);
    return res.status(500).json({ error: '服务器内部错误' });
  }
  next();
});

// HTTP 服务器（在 main() 中启动）
let server;

/**
 * 启动 HTTP 服务器。
 * 返回 Promise：监听成功 resolve，端口占用等错误 reject。
 * 这样 main() 可以用 await 等监听真正成功后再启动 mDNS / 定时清理，
 * 避免端口失败时仍把后续步骤跑起来。
 */
function startHttpServer() {
  return new Promise((resolve, reject) => {
    server = app.listen(PORT, '0.0.0.0', () => {
      const addresses = getAllLocalIPs();

      console.log('');
      console.log(`🚀 本地文件交互系统 v${APP_VERSION} 已启动`);
      if (IS_PACKAGED) {
        console.log(`📦 运行方式: 单文件 exe（数据目录 ${APP_ROOT}）`);
      }
      console.log(`📡 监听端口: ${PORT}（所有网卡）`);

      if (addresses.length === 0) {
        console.log(`📡 未探测到局域网地址，请使用 http://localhost:${PORT}`);
      } else {
        console.log(`📡 可用访问地址（本机有多个网卡，请挑一个手机/其他设备能连通的网段）:`);
        addresses.forEach((item, index) => {
          const mark = item.ip === LOCAL_IP ? '  ← 默认用于二维码' : '';
          console.log(`   ${index + 1}. ${item.url}    [${item.interface}]${mark}`);
        });
        if (addresses.length > 1) {
          console.log(`   （也可以在网页上「服务地址」处切换，二维码会跟随所选地址）`);
        }
      }

      console.log(`📡 本机地址: http://localhost:${PORT}`);
      console.log(`🔧 管理后台: http://localhost:${PORT + 1}`);
      console.log('📱 移动端扫码访问，或手动输入上述地址');
      console.log('👤 作者: 你们喜爱的老王  ·  B站 @你们喜爱的老王  ·  GitHub @ops120');
      console.log('');

      // 启动管理后台
      try {
        startAdminServer(PORT + 1, CONFIG);
      } catch (error) {
        console.warn('⚠️  管理后台启动失败:', error.message);
      }

      resolve();
    });

    // WebSocket 升级
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    // 端口占用等启动错误给出可读提示，而不是抛裸异常
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`\n❌ 端口 ${PORT} 已被占用，请关闭占用进程或修改 config.json 中的端口\n`);
      } else {
        console.error('\n❌ 服务启动失败:', error.message, '\n');
      }
      reject(error);
    });
  });
}

// mDNS 服务发现
let bonjour = null;

function startMdns() {
  try {
    bonjour = new Bonjour();
    bonjour.publish({
      name: 'LocalFileShare',
      type: 'http',
      port: PORT,
      txt: {
        path: '/'
      }
    });
    console.log('🔍 mDNS 服务已发布，局域网设备可自动发现');
  } catch (error) {
    console.warn('⚠️  mDNS 发布失败（不影响使用）:', error.message);
  }
}

// 定时清理（每小时）
function startCleanupTimer() {
  setInterval(cleanupExpiredFiles, 60 * 60 * 1000);
}

// 优雅退出
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  saveDatabase();
  try {
    if (bonjour) {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        server.close();
        process.exit(0);
      });
    } else {
      server.close();
      process.exit(0);
    }
  } catch (error) {
    server.close();
    process.exit(0);
  }
  // 兜底：10 秒内未能正常退出则强制结束
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  // 数据库必须先就绪，之后的路由/定时任务才会用到它
  await initDatabase();

  // 等 HTTP 监听真正成功后才启动 mDNS / 定时清理；端口占用等错误会 reject，
  // 进入 catch 后只显示错误并暂停等待，不再跑后续步骤
  try {
    await startHttpServer();
  } catch (error) {
    waitForExit();
    return;
  }

  startMdns();
  startCleanupTimer();

  // 启动时登记一次上传目录里已有的文件（例如服务停止期间拷进去的）
  try {
    const importedOnStart = importUntrackedFiles();
    if (importedOnStart > 0) {
      console.log(`📂 已登记上传目录中已有的 ${importedOnStart} 个文件`);
    }
  } catch (error) {
    console.warn('启动扫描上传目录失败:', error.message);
  }
}

main().catch((error) => {
  console.error('❌ 启动失败:', error.message);
  waitForExit();
});

/** 启动失败时暂停，让双击运行的用户能看见错误信息，而不是窗口一闪就关 */
function waitForExit() {
  if (process.stdin.isTTY) {
    // 在已有控制台里运行：等回车
    console.log('按回车键退出...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else {
    // 双击运行（无控制台 / Windows 给的新控制台）：等任意按键
    console.log('\n按任意键退出...');
    try {
      // fs 已在文件顶部 import，不要在 ESM 里用 require——require 未定义会被 catch 吞掉，
      // 导致双击 exe 启动失败时 startup-error.log 永远写不出，"闪退修复"等于没修。
      fs.writeFileSync(path.join(APP_ROOT, 'startup-error.log'),
        `启动失败: ${new Error().stack || '未知错误'}\n`, 'utf-8');
    } catch (error) {
      // 写不了日志也不影响
    }
    // 用 mode 等按键（兼容 Git Bash / cmd / 双击）
    try {
      execFileSync('cmd', ['/c', 'pause'], { stdio: 'inherit', windowsHide: false });
    } catch (error) {
      // 回退：阻塞等待 stdin
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(1));
    }
  }
}
