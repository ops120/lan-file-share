import { create } from 'zustand';

const API_BASE = '/api';

// 正在进行中的上传请求，供「取消上传」调用。
// 用 XMLHttpRequest 而不是 fetch：只有 XHR 能拿到 upload 进度事件，
// 从而算出已传字节数、百分比与实时速度。
let activeUploadXhr = null;

function describeUploadTarget(list) {
  if (list.length === 1) {
    return list[0].name;
  }
  return `${list[0].name} 等 ${list.length} 个文件`;
}

export const useStore = create((set, get) => ({
  files: [],
  serverInfo: null,
  uploading: false,
  uploadProgress: null,
  filesLoading: true,
  filesError: null,
  ws: null,
  wsReconnectTimer: null,
  wsReconnectAttempts: 0,

  // 初始化 WebSocket
  initWebSocket: () => {
    // 已有连接或已有重连计划时不重复建立连接（React StrictMode 下 effect 会跑两次）
    const { ws, wsReconnectTimer } = get();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (wsReconnectTimer) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.onopen = () => {
      set({ wsReconnectAttempts: 0 });
    };

    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        console.error('WebSocket 消息解析失败:', err);
        return;
      }

      if (data.type === 'file_uploaded') {
        get().fetchFiles();
      } else if (data.type === 'file_deleted') {
        set(state => ({
          files: state.files.filter(f => f.id !== data.fileId)
        }));
      } else if (data.type === 'file_updated') {
        get().fetchFiles();
      } else if (data.type === 'file_favorite') {
        set(state => ({
          files: state.files.map(f =>
            f.id === data.fileId ? { ...f, is_favorite: data.isFavorite ? 1 : 0 } : f
          )
        }));
      }
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    socket.onclose = () => {
      // 旧连接已关闭，清空引用后再安排重连，避免连接数越滚越多
      if (get().ws === socket) {
        set({ ws: null });
      }

      // 指数退避，最多 30 秒一次，服务长时间不可用时不再每 3 秒死磕
      const attempts = get().wsReconnectAttempts + 1;
      const delay = Math.min(3000 * attempts, 30000);
      const timer = setTimeout(() => {
        set({ wsReconnectTimer: null });
        get().initWebSocket();
      }, delay);

      set({ wsReconnectAttempts: attempts, wsReconnectTimer: timer });
    };

    set({ ws: socket });
  },

  // 关闭 WebSocket（组件卸载时调用）
  closeWebSocket: () => {
    const { ws, wsReconnectTimer } = get();
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      set({ wsReconnectTimer: null });
    }
    if (ws) {
      ws.onclose = null;
      ws.close();
      set({ ws: null });
    }
  },

  // 获取服务器信息
  fetchServerInfo: async () => {
    try {
      const res = await fetch(`${API_BASE}/info`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ serverInfo: data });
    } catch (err) {
      console.error('Failed to fetch server info:', err);
    }
  },

  // 获取文件列表
  fetchFiles: async () => {
    try {
      const res = await fetch(`${API_BASE}/files`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // 后端异常时会返回 {error: ...} 这类对象，直接塞进 files 会让列表渲染崩溃
      if (!Array.isArray(data)) {
        throw new Error('文件列表响应格式异常');
      }

      set({ files: data, filesLoading: false, filesError: null });
    } catch (err) {
      console.error('Failed to fetch files:', err);
      set({ filesLoading: false, filesError: '加载文件列表失败，请刷新重试' });
    }
  },

  // 上传文件（带进度与实时速度）
  uploadFiles: async (files) => {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }

    const formData = new FormData();
    list.forEach(file => {
      formData.append('files', file);
    });
    formData.append('device', navigator.userAgent);

    const totalBytes = list.reduce((sum, file) => sum + (file.size || 0), 0);
    const label = describeUploadTarget(list);

    set({
      uploading: true,
      filesError: null,
      uploadProgress: {
        loaded: 0,
        total: totalBytes,
        percent: 0,
        speed: 0,
        remaining: null,
        fileName: label,
        finalizing: false
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeUploadXhr = xhr;

        let lastSampleTime = Date.now();
        let lastSampleLoaded = 0;
        let smoothedSpeed = 0;

        const publish = (loaded, total, extra = {}) => {
          const now = Date.now();
          const elapsed = (now - lastSampleTime) / 1000;

          // 每 300ms 采样一次并做指数平滑，避免速度数字剧烈跳动
          if (elapsed >= 0.3) {
            const instant = Math.max(0, (loaded - lastSampleLoaded) / elapsed);
            smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed * 0.7 + instant * 0.3 : instant;
            lastSampleTime = now;
            lastSampleLoaded = loaded;
          }

          set({
            uploadProgress: {
              loaded,
              total,
              percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
              speed: smoothedSpeed,
              remaining: smoothedSpeed > 0 && total > loaded ? (total - loaded) / smoothedSpeed : null,
              fileName: label,
              ...extra
            }
          });
        };

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            publish(event.loaded, event.total);
          }
        };

        // 请求体发完但服务端仍在处理（大文件落库/合并）时，给出与"传输中"不同的状态
        xhr.upload.onload = () => {
          publish(totalBytes, totalBytes, { finalizing: true, percent: 100, remaining: 0 });
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
            return;
          }

          let reason = `HTTP ${xhr.status}`;
          try {
            const payload = JSON.parse(xhr.responseText);
            if (payload && payload.error) {
              reason = payload.error;
            }
          } catch (error) {
            // 响应不是 JSON，保留状态码
          }
          reject(new Error(reason));
        };

        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.ontimeout = () => reject(new Error('上传超时'));
        xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));

        xhr.open('POST', `${API_BASE}/upload`);
        xhr.send(formData);
      });

      await get().fetchFiles();
    } catch (err) {
      if (err && err.cancelled) {
        // 用户主动取消不算失败，不弹提示
      } else {
        console.error('Upload failed:', err);
        alert(`上传失败：${err.message}`);
      }
    } finally {
      activeUploadXhr = null;
      set({ uploading: false, uploadProgress: null });
    }
  },

  // 取消进行中的上传
  cancelUpload: () => {
    if (activeUploadXhr) {
      activeUploadXhr.abort();
    }
  },

  // 删除文件
  deleteFile: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/files/${id}`, {
        method: 'DELETE'
      });

      if (res.ok) {
        set(state => ({
          files: state.files.filter(f => f.id !== id)
        }));
      } else {
        alert(`删除失败：HTTP ${res.status}`);
      }
    } catch (err) {
      console.error('Delete failed:', err);
      alert('删除失败，请检查网络后重试');
    }
  },

  // 下载文件
  downloadFile: (id) => {
    window.open(`${API_BASE}/download/${id}`, '_blank');
  },

  // 收藏 / 取消收藏（先乐观更新，失败回滚）
  toggleFavorite: async (id) => {
    const previous = get().files.find(f => f.id === id);
    if (!previous) return;

    // 明确告知服务端目标状态，而不是让服务端"取反"：
    // 多设备同时点击时取反语义会互相覆盖
    const target = !previous.is_favorite;

    set(state => ({
      files: state.files.map(f =>
        f.id === id ? { ...f, is_favorite: target ? 1 : 0 } : f
      )
    }));

    try {
      const res = await fetch(`${API_BASE}/files/${id}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: target })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set(state => ({
        files: state.files.map(f =>
          f.id === id ? { ...f, is_favorite: data.is_favorite } : f
        )
      }));
    } catch (err) {
      console.error('Favorite failed:', err);
      set(state => ({
        files: state.files.map(f =>
          f.id === id ? { ...f, is_favorite: previous.is_favorite } : f
        )
      }));
    }
  },

  // 获取二维码（host 用于多网卡场景指定地址，不传则由服务端使用推荐地址）
  getQRCode: async (id, host) => {
    try {
      const query = host ? `?host=${encodeURIComponent(host)}` : '';
      const res = await fetch(`${API_BASE}/qrcode/${id}${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // 缺少 url 时不能交给二维码组件渲染，否则会直接抛错导致白屏
      return data && data.url ? data : null;
    } catch (err) {
      console.error('Failed to get QR code:', err);
      return null;
    }
  },

  // 获取连接二维码
  getConnectQRCode: async (host) => {
    try {
      const query = host ? `?host=${encodeURIComponent(host)}` : '';
      const res = await fetch(`${API_BASE}/connect-qrcode${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data && data.url ? data : null;
    } catch (err) {
      console.error('Failed to get connect QR code:', err);
      return null;
    }
  }
}));
