import { useEffect, useState, useRef } from 'react';
import { useStore } from './store';
import { QRCodeSVG } from 'qrcode.react';
import { readStoredTheme, applyTheme, storeTheme } from './theme';

function App() {
  const {
    files,
    serverInfo,
    uploading,
    uploadProgress,
    filesError,
    fetchFiles,
    fetchServerInfo,
    initWebSocket,
    closeWebSocket,
    uploadFiles,
    cancelUpload,
    deleteFile,
    downloadFile,
    toggleFavorite,
    getQRCode,
    getConnectQRCode
  } = useStore();

  const [dragActive, setDragActive] = useState(false);
  const [showConnectQR, setShowConnectQR] = useState(false);
  const [connectQRData, setConnectQRData] = useState(null);
  const [selectedFileQR, setSelectedFileQR] = useState(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const [selectedIP, setSelectedIP] = useState(null);
  const [theme, setTheme] = useState(readStoredTheme);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetchServerInfo();
    fetchFiles();
    initWebSocket();

    // 卸载时断开连接，避免 StrictMode 双执行/热更新累积出多条连接与重连定时器
    return () => {
      closeWebSocket();
    };
  }, []);

  // 主题：默认白天，切换后写入本地存储
  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(current => (current === 'dark' ? 'light' : 'dark'));
  };

  // 预览弹窗支持 Esc 关闭
  useEffect(() => {
    if (!previewFile) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setPreviewFile(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewFile]);

  // 本机可能有多个网卡（有线/无线/虚拟网卡/VPN），不同设备能连通的网段不同，
  // 这里把可访问地址全部列出来，默认选中服务端推荐的那个，并记住使用者的选择。
  const addresses = serverInfo?.addresses?.length
    ? serverInfo.addresses
    : (serverInfo ? [{ ip: serverInfo.ip, url: serverInfo.url, interface: '', recommended: true }] : []);

  useEffect(() => {
    if (!serverInfo?.addresses?.length) return;

    setSelectedIP((previous) => {
      let remembered = previous;
      if (!remembered) {
        try {
          remembered = window.localStorage.getItem('selectedServerIP');
        } catch (error) {
          remembered = null;
        }
      }

      if (remembered && serverInfo.addresses.some(item => item.ip === remembered)) {
        return remembered;
      }

      const recommended = serverInfo.addresses.find(item => item.recommended);
      return recommended ? recommended.ip : serverInfo.addresses[0].ip;
    });
  }, [serverInfo]);

  const currentAddress = addresses.find(item => item.ip === selectedIP) || addresses[0] || null;

  // 网卡名可能很长（如 "VirtualBox Host-Only Network"），原生 select 会按最宽选项撑开，
  // 窄屏下必须截断，否则整个页面出现横向滚动
  const shortInterface = (name) => {
    if (!name) return '';
    return name.length > 12 ? `${name.slice(0, 12)}…` : name;
  };

  const handleSelectIP = (ip) => {
    setSelectedIP(ip);
    try {
      window.localStorage.setItem('selectedServerIP', ip);
    } catch (error) {
      // 隐私模式下 localStorage 可能不可用，忽略即可
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (uploading) return;

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  };

  const handleFileSelect = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFiles(e.target.files);
    }
    // 允许再次选择同一个文件：不清空 value 时 change 事件不会触发
    e.target.value = '';
  };

  const handleUpdateFile = (fileId) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const file = e.target.files[0];
        const formData = new FormData();
        formData.append('file', file);

        try {
          const response = await fetch(`/api/files/${fileId}`, {
            method: 'PUT',
            body: formData
          });

          if (response.ok) {
            await fetchFiles();
          } else {
            alert('更新文件失败');
          }
        } catch (error) {
          console.error('Update error:', error);
          alert('更新文件失败');
        }
      }
    };
    input.click();
  };

  const handleShowConnectQR = async () => {
    const data = await getConnectQRCode(currentAddress?.ip);
    if (!data) {
      alert('获取二维码失败，请检查网络后重试');
      return;
    }
    setConnectQRData(data);
    setShowConnectQR(true);
  };

  const handleShowFileQR = async (fileId) => {
    const data = await getQRCode(fileId, currentAddress?.ip);
    if (!data) {
      alert('获取二维码失败，请检查网络后重试');
      return;
    }
    setSelectedFileQR({ fileId, ...data });
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;

    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // 上传速度（字节/秒）与剩余时间
  const formatSpeed = (bytesPerSecond) => {
    if (!bytesPerSecond || bytesPerSecond <= 0) return '';
    return `${formatSize(Math.round(bytesPerSecond))}/s`;
  };

  const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '不到 1 秒';
    if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.ceil(seconds % 60);
    return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
  };

  const getFileIcon = (mimeType) => {
    if (!mimeType) return '📄';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '📹';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📕';
    if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
    if (mimeType.includes('word')) return '📝';
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '📊';
    return '📄';
  };

  // 哪些类型能在线预览：视频/图片/音频用原生标签，PDF 用浏览器内置阅读器
  // 有些客户端上传时不会给准确的 MIME（统一报 application/octet-stream），
  // 所以 MIME 不可靠时回退按扩展名判断，否则这类文件连"预览"按钮都不会出现。
  const PREVIEW_EXTENSIONS = {
    video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv', '3gp', 'wmv', 'flv', 'ts'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'tiff'],
    audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'],
    pdf: ['pdf']
  };

  const previewKind = (file) => {
    const mime = file?.mime_type || '';
    const generic = !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream';

    if (!generic) {
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime === 'application/pdf') return 'pdf';
      return null;
    }

    const ext = (file?.filename || '').split('.').pop()?.toLowerCase() || '';
    for (const [kind, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
      if (extensions.includes(ext)) return kind;
    }
    return null;
  };

  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  // 后端没有"总容量"概念，真实约束是单文件大小上限，由 /api/info 下发
  const maxSize = serverInfo?.maxFileSize || 1024 * 1024 * 1024;
  const favoriteCount = files.filter(f => f.is_favorite).length;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleFiles = (showFavoritesOnly ? files.filter(f => f.is_favorite) : files)
    .filter(f => !normalizedQuery || f.filename.toLowerCase().includes(normalizedQuery));

  // 空列表区分「没有文件」「没有收藏」「搜索无结果」三种情况
  let emptyMessage = '暂无文件';
  if (filesError) {
    emptyMessage = filesError;
  } else if (normalizedQuery) {
    emptyMessage = '没有匹配的文件';
  } else if (showFavoritesOnly) {
    emptyMessage = '暂无收藏文件';
  }

  return (
    <div className="min-h-screen bg-surface-1 text-body">
      {/* Header */}
      <header className="border-b border-surface-4 bg-surface-2">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-2xl">📁</div>
            <h1 className="text-xl font-semibold text-strong">本地文件交互系统</h1>
          </div>
          <button
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? '切换到白天主题' : '切换到夜间主题'}
            title={theme === 'dark' ? '切换到白天主题' : '切换到夜间主题'}
            className="theme-toggle shrink-0 h-10 min-w-[60px] px-4 rounded-full bg-surface-4 hover:bg-surface-5 text-body text-sm font-medium transition-colors"
          >
            {theme === 'dark' ? '☀️ 白天' : '🌙 夜间'}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Server Info */}
        {serverInfo && (
          <div className="bg-surface-3 rounded-3xl p-6 mb-8 border border-surface-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="text-sm text-soft mb-1">服务地址</div>
                <div className="font-mono text-lg text-strong mb-2">{currentAddress?.url || serverInfo.url}</div>

                {addresses.length > 1 && (
                  <div className="mb-4">
                    <label htmlFor="server-address" className="block text-xs text-soft mb-1">
                      检测到 {addresses.length} 个本机地址，请选择你的手机/其他设备能连通的网段
                    </label>
                    {/* appearance-none + 自绘箭头：原生下拉箭头在部分环境不渲染，用户会看不出可点 */}
                    <div className="relative block sm:inline-block max-w-full">
                      <select
                        id="server-address"
                        value={selectedIP || ''}
                        onChange={(e) => handleSelectIP(e.target.value)}
                        className="appearance-none w-full sm:w-auto max-w-full truncate bg-surface-4 border border-surface-4 hover:border-surface-5 rounded-full pl-4 pr-10 py-2 text-sm text-body focus:outline-none focus:border-accent cursor-pointer"
                      >
                        {addresses.map((item) => (
                          <option key={item.ip} value={item.ip}>
                            {item.ip}
                            {item.interface ? `（${shortInterface(item.interface)}）` : ''}
                            {item.recommended ? ' ★推荐' : ''}
                          </option>
                        ))}
                      </select>
                      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-soft text-xs">
                        ▾
                      </span>
                    </div>
                  </div>
                )}

                <div className="text-sm text-soft mb-2">二维码访问</div>
                <button
                  onClick={handleShowConnectQR}
                  className="bg-accent hover:bg-accent-muted text-surface-1 px-6 py-2.5 rounded-full font-semibold text-sm transition-colors"
                >
                  📱 显示连接二维码
                </button>
              </div>
              <div className="text-right">
                <div className="text-sm text-soft mb-1">存储使用</div>
                <div className="text-lg font-semibold text-strong">
                  {formatSize(totalSize)} <span className="text-faint">/ 单文件上限 {formatSize(maxSize)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Upload Area */}
        <section
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          className={`bg-surface-2 rounded-3xl p-12 mb-8 border-2 border-dashed transition-all ${
            dragActive ? 'border-accent bg-surface-3' : 'border-surface-4'
          }`}
        >
          <h2 className="text-lg font-semibold text-strong text-center mb-4">上传文件</h2>
          <div className="text-center">
            <div className="text-6xl mb-4">
              {uploading ? '⏳' : '📤'}
            </div>

            {uploading && uploadProgress ? (
              <div className="max-w-md mx-auto">
                <p className="text-lg text-body mb-3">
                  上传中... {uploadProgress.percent}%
                  {uploadProgress.finalizing ? '（已发送，服务器处理中）' : ''}
                </p>

                <div className="h-2 bg-surface-4 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-200"
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>

                <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-soft">
                  <span className="truncate max-w-[14rem]" title={uploadProgress.fileName}>
                    {uploadProgress.fileName}
                  </span>
                  <span className="font-mono">
                    {formatSize(uploadProgress.loaded)} / {formatSize(uploadProgress.total)}
                    {formatSpeed(uploadProgress.speed) ? ` · ${formatSpeed(uploadProgress.speed)}` : ''}
                    {uploadProgress.remaining ? ` · 剩余 ${formatDuration(uploadProgress.remaining)}` : ''}
                  </span>
                </div>

                <button
                  onClick={cancelUpload}
                  className="mt-4 px-6 py-2 bg-surface-4 hover:bg-surface-5 text-body rounded-full text-sm font-medium transition-colors"
                >
                  取消上传
                </button>
              </div>
            ) : (
              <>
                <p className="text-lg text-body mb-4">
                  拖拽文件到此处上传，或点击按钮选择文件
                </p>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="bg-accent hover:bg-accent-muted text-surface-1 px-8 py-3 rounded-full font-semibold transition-colors"
                >
                  选择文件
                </button>
              </>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
        </section>

        {/* File List */}
        {files.length > 0 && (
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <h2 className="text-lg font-semibold text-strong">
              文件列表（{normalizedQuery || showFavoritesOnly ? `${visibleFiles.length} / ${files.length}` : files.length}）
            </h2>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索文件名"
                  aria-label="搜索文件名"
                  className="bg-surface-3 border border-surface-4 focus:border-accent rounded-full pl-4 pr-9 py-2 text-sm text-body w-56 max-w-full focus:outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:appearance-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    aria-label="清空搜索"
                    title="清空搜索"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-soft hover:text-body text-sm leading-none"
                  >
                    ✕
                  </button>
                )}
              </div>
              <button
                onClick={() => setShowFavoritesOnly(v => !v)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  showFavoritesOnly
                    ? 'bg-amber-500/15 text-amber-700 border border-amber-500/40 dark:bg-amber-400/20 dark:text-amber-300 dark:border-amber-400/40'
                    : 'bg-surface-4 text-body border border-surface-4'
                }`}
              >
                {showFavoritesOnly ? '★ 只看收藏' : '☆ 只看收藏'}（{favoriteCount}）
              </button>
            </div>
          </div>
        )}

        {visibleFiles.length > 0 ? (
          <div className="space-y-3">
            {visibleFiles.map(file => (
              <div
                key={file.id}
                className="bg-surface-3 rounded-2xl p-5 border border-surface-4 hover:border-surface-5 transition-colors"
              >
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="text-4xl">{getFileIcon(file.mime_type)}</div>
                  <div className="flex-1 min-w-0">
                    {previewKind(file) ? (
                      <button
                        onClick={() => setPreviewFile(file)}
                        title={`预览 ${file.filename}`}
                        className="font-medium text-strong truncate block max-w-full min-h-[36px] py-2 text-left hover:text-accent hover:underline transition-colors"
                      >
                        {file.filename}
                      </button>
                    ) : (
                      <div className="font-medium text-strong truncate mb-1" title={file.filename}>{file.filename}</div>
                    )}
                    <div className="text-sm text-soft">
                      {formatSize(file.size)} · {formatTime(file.upload_time)}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {previewKind(file) && (
                      <button
                        onClick={() => setPreviewFile(file)}
                        className="px-4 py-2 bg-surface-4 hover:bg-surface-5 text-body rounded-full text-sm font-medium transition-colors"
                      >
                        预览
                      </button>
                    )}
                    <button
                      onClick={() => toggleFavorite(file.id)}
                      aria-pressed={!!file.is_favorite}
                      className={`favorite-button px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                        file.is_favorite
                          ? 'is-favorite bg-amber-500/15 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300'
                          : 'bg-surface-4 hover:bg-surface-5 text-body'
                      }`}
                    >
                      {file.is_favorite ? '★ 已收藏' : '☆ 收藏'}
                    </button>
                    <button
                      onClick={() => handleShowFileQR(file.id)}
                      className="px-4 py-2 bg-surface-4 hover:bg-surface-5 text-body rounded-full text-sm font-medium transition-colors"
                    >
                      二维码
                    </button>
                    <button
                      onClick={() => downloadFile(file.id)}
                      className="px-4 py-2 bg-accent hover:bg-accent-muted text-surface-1 rounded-full text-sm font-semibold transition-colors"
                    >
                      下载
                    </button>
                    <button
                      onClick={() => handleUpdateFile(file.id)}
                      className="px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 dark:text-blue-400 rounded-full text-sm font-medium transition-colors"
                      title="重新上传替换此文件"
                    >
                      更新
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('确认删除此文件？')) {
                          deleteFile(file.id);
                        }
                      }}
                      className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:bg-red-900/30 dark:hover:bg-red-900/50 dark:text-red-400 rounded-full text-sm font-medium transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-16 text-soft">
            <div className="text-5xl mb-4">{filesError ? '⚠️' : normalizedQuery ? '🔍' : '📭'}</div>
            <p>{emptyMessage}</p>
          </div>
        )}
      </main>

      {/* 作者信息 */}
      <footer className="border-t border-surface-4 mt-8 py-6">
        <div className="max-w-7xl mx-auto px-6 text-center text-xs text-soft flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <span>本地文件交互系统</span>
          <span className="text-faint">·</span>
          <span className="text-body font-medium">作者：你们喜爱的老王</span>
          <span className="text-faint">·</span>
          <span>B 站 @你们喜爱的老王</span>
          <span className="text-faint">·</span>
          <a
            href="https://github.com/ops120"
            target="_blank"
            rel="noreferrer"
            className="hover:text-accent transition-colors"
          >
            GitHub @ops120
          </a>
        </div>
      </footer>

      {/* Connect QR Modal */}
      {showConnectQR && connectQRData && (
        <div
          className="fixed inset-0 bg-overlay flex items-center justify-center p-6 z-50"
          onClick={() => setShowConnectQR(false)}
        >
          <div
            className="bg-surface-2 rounded-3xl p-8 max-w-md w-full border border-surface-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-strong mb-6 text-center">扫码连接</h3>
            <div className="bg-white p-6 rounded-2xl mb-6 flex items-center justify-center">
              <QRCodeSVG value={connectQRData.url} size={240} />
            </div>
            <div className="text-center">
              <div className="text-sm text-soft mb-2">或手动输入地址</div>
              <div className="font-mono text-accent text-sm">{connectQRData.url}</div>
            </div>
            <button
              onClick={() => setShowConnectQR(false)}
              className="w-full mt-6 bg-surface-4 hover:bg-surface-5 text-body py-3 rounded-full font-semibold transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* File QR Modal */}
      {selectedFileQR && (
        <div
          className="fixed inset-0 bg-overlay flex items-center justify-center p-6 z-50"
          onClick={() => setSelectedFileQR(null)}
        >
          <div
            className="bg-surface-2 rounded-3xl p-8 max-w-md w-full border border-surface-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-strong mb-6 text-center">扫码下载</h3>
            <div className="bg-white p-6 rounded-2xl mb-6 flex items-center justify-center">
              <QRCodeSVG value={selectedFileQR.url} size={240} />
            </div>
            <div className="text-center">
              <div className="text-sm text-soft mb-2">使用手机扫描二维码下载文件</div>
              <div className="font-mono text-accent text-xs break-all">{selectedFileQR.url}</div>
            </div>
            <button
              onClick={() => setSelectedFileQR(null)}
              className="w-full mt-6 bg-surface-4 hover:bg-surface-5 text-body py-3 rounded-full font-semibold transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 在线预览弹窗（视频/图片/音频/PDF） */}
      {previewFile && (
        <div
          className="fixed inset-0 bg-overlay flex items-center justify-center p-4 z-50"
          onClick={() => setPreviewFile(null)}
        >
          <div
            className="bg-surface-2 rounded-3xl p-5 md:p-6 w-full max-w-4xl border border-surface-4"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="文件预览"
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <h3 className="text-base md:text-lg font-semibold text-strong break-all" data-testid="preview-title">
                {previewFile.filename}
              </h3>
              <button
                onClick={() => setPreviewFile(null)}
                aria-label="关闭预览"
                title="关闭预览（Esc）"
                className="shrink-0 w-9 h-9 rounded-full bg-surface-4 hover:bg-surface-5 text-body transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="bg-overlay rounded-2xl overflow-hidden flex items-center justify-center min-h-[200px]">
              {previewKind(previewFile) === 'video' && (
                <video
                  src={`/api/preview/${previewFile.id}`}
                  controls
                  autoPlay
                  playsInline
                  className="w-full max-h-[70vh] bg-black"
                >
                  您的浏览器不支持视频播放，请
                  <a href={`/api/preview/${previewFile.id}`}>点此打开</a>
                </video>
              )}

              {previewKind(previewFile) === 'image' && (
                <img
                  src={`/api/preview/${previewFile.id}`}
                  alt={previewFile.filename}
                  className="max-h-[70vh] max-w-full object-contain"
                />
              )}

              {previewKind(previewFile) === 'audio' && (
                <div className="w-full p-8">
                  <div className="text-5xl text-center mb-6">🎵</div>
                  <audio src={`/api/preview/${previewFile.id}`} controls autoPlay className="w-full" />
                </div>
              )}

              {previewKind(previewFile) === 'pdf' && (
                <iframe
                  src={`/api/preview/${previewFile.id}`}
                  title={previewFile.filename}
                  className="w-full h-[70vh] bg-white"
                />
              )}

              {!previewKind(previewFile) && (
                <div className="text-center py-12 text-soft">
                  <div className="text-5xl mb-4">📄</div>
                  <p>该文件类型不支持在线预览，请下载后查看</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 mt-4 flex-wrap">
              <span className="text-xs text-soft">
                {formatSize(previewFile.size)} · {previewFile.mime_type || '未知类型'}
              </span>
              <div className="flex gap-2">
                <a
                  href={`/api/preview/${previewFile.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-4 py-2 bg-surface-4 hover:bg-surface-5 text-body rounded-full text-sm font-medium transition-colors"
                >
                  在新窗口打开
                </a>
                <button
                  onClick={() => downloadFile(previewFile.id)}
                  className="px-4 py-2 bg-accent hover:bg-accent-muted text-surface-1 rounded-full text-sm font-semibold transition-colors"
                >
                  下载
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
