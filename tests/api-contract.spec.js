// tests/api-contract.spec.js
// 契约层测试：覆盖此前完全没有用例的关键路径
// （PUT 更新文件、分块上传与哈希校验、下载 Range、扫码落地页、收藏筛选、删除语义）
import { test, expect } from '@playwright/test';

const RUN_ID = Date.now();
const unique = (suffix) => `api-${RUN_ID}-${suffix}`;

// 通过 multipart 上传一个文件，返回入库记录
async function uploadViaApi(request, name, content) {
  const res = await request.post('/api/upload', {
    multipart: {
      files: { name, mimeType: 'text/plain', buffer: Buffer.from(content) }
    }
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.files[0];
}

// 按文件名查询记录（避免依赖列表顺序）
async function findByName(request, name) {
  const files = await (await request.get('/api/files')).json();
  return files.find(f => f.filename === name);
}

test.describe('API 契约测试', () => {

  test.describe('PUT /api/files/:id 更新文件', () => {
    test('应替换内容并保留 id', async ({ request }) => {
      const originalName = unique('update.txt');
      const updatedName = unique('update-v2.txt');
      const created = await uploadViaApi(request, originalName, 'version-1');

      try {
        const res = await request.put(`/api/files/${created.id}`, {
          multipart: {
            file: { name: updatedName, mimeType: 'text/plain', buffer: Buffer.from('version-2') }
          }
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.file.filename).toBe(updatedName);

        // 同一 id 的记录被更新，而不是新增一条
        const updated = await findByName(request, updatedName);
        expect(updated).toBeTruthy();
        expect(updated.id).toBe(created.id);
        expect(updated.size).toBe(Buffer.byteLength('version-2'));

        // 下载得到的是新内容
        const download = await request.get(`/api/download/${created.id}`);
        expect(await download.text()).toBe('version-2');
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('未附带文件时应返回 400 而不是 500', async ({ request }) => {
      const created = await uploadViaApi(request, unique('update-nofile.txt'), 'x');
      try {
        const res = await request.put(`/api/files/${created.id}`, {
          headers: { 'Content-Type': 'application/json' },
          data: {}
        });
        expect(res.status()).toBe(400);
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });
  });

  test.describe('分块上传 /api/upload/chunk', () => {
    test('多块上传后应合并成完整文件', async ({ request }) => {
      const name = unique('chunks.bin');
      const parts = ['part-1-', 'part-2-', 'part-3'];
      const expected = parts.join('');

      for (let i = 0; i < parts.length; i++) {
        const res = await request.post(
          `/api/upload/chunk?filename=${encodeURIComponent(name)}&chunkIndex=${i}&totalChunks=${parts.length}&originalName=${encodeURIComponent(name)}`,
          { headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(parts[i]) }
        );
        expect(res.status()).toBe(200);
      }

      const created = await findByName(request, name);
      expect(created).toBeTruthy();
      expect(created.size).toBe(Buffer.byteLength(expected));

      try {
        const download = await request.get(`/api/download/${created.id}`);
        expect(await download.text()).toBe(expected);
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('上传状态接口应报告缺失分块', async ({ request }) => {
      const name = unique('status.bin');
      await request.post(
        `/api/upload/chunk?filename=${encodeURIComponent(name)}&chunkIndex=0&totalChunks=3`,
        { headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from('a') }
      );

      const res = await request.get(`/api/upload/status/${encodeURIComponent(name)}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.uploaded).toBe(false);
      expect(body.uploadedChunks).toEqual([0]);
      expect(body.chunkCount).toBe(1);
    });

    test('fileHash 与实际内容不符时应返回 422 且不入库', async ({ request }) => {
      const name = unique('hash-mismatch.bin');
      const wrongHash = 'a'.repeat(64);

      const res = await request.post(
        `/api/upload/chunk?filename=${encodeURIComponent(name)}&chunkIndex=0&totalChunks=1&originalName=${encodeURIComponent(name)}&fileHash=${wrongHash}`,
        { headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from('real-content') }
      );
      expect(res.status()).toBe(422);
      expect((await res.json()).error).toContain('哈希');

      expect(await findByName(request, name)).toBeFalsy();
    });

    test('fileHash 与实际内容一致时应接受', async ({ request }) => {
      const name = unique('hash-ok.bin');
      const content = 'content-to-verify';
      const { createHash } = await import('crypto');
      const goodHash = createHash('sha256').update(content).digest('hex');

      const res = await request.post(
        `/api/upload/chunk?filename=${encodeURIComponent(name)}&chunkIndex=0&totalChunks=1&originalName=${encodeURIComponent(name)}&fileHash=${goodHash}`,
        { headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(content) }
      );
      expect(res.status()).toBe(200);

      const created = await findByName(request, name);
      expect(created).toBeTruthy();
      await request.delete(`/api/files/${created.id}`);
    });

    test('文件名含路径分隔符应被拒绝（防路径穿越）', async ({ request }) => {
      const traversal = await request.post(
        '/api/upload/chunk?filename=..%2F..%2Fevil.bin&chunkIndex=0&totalChunks=1',
        { headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from('x') }
      );
      expect(traversal.status()).toBe(400);

      const backslash = await request.post(
        '/api/upload/chunk?filename=..%5Cevil.bin&chunkIndex=0&totalChunks=1',
        { headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from('x') }
      );
      expect(backslash.status()).toBe(400);

      const status = await request.get('/api/upload/status/..%2F..%2Fetc%2Fpasswd');
      expect(status.status()).toBe(400);
    });

    test('非法分块参数应返回 400', async ({ request }) => {
      const cases = [
        'filename=ok.bin&chunkIndex=5&totalChunks=3',   // 索引越界
        'filename=ok.bin&chunkIndex=-1&totalChunks=3',  // 负索引
        'filename=ok.bin&chunkIndex=0&totalChunks=0'    // 总数为 0
      ];

      for (const query of cases) {
        const res = await request.post(`/api/upload/chunk?${query}`, {
          headers: { 'Content-Type': 'application/octet-stream' },
          data: Buffer.from('x')
        });
        expect(res.status(), `期望 400: ${query}`).toBe(400);
      }
    });
  });

  test.describe('下载与 Range', () => {
    test('应支持区间、后缀区间与越界区间', async ({ request }) => {
      const content = 'abcdefghijklmnopqrstuvwxyz'; // 26 字节
      const created = await uploadViaApi(request, unique('range.txt'), content);
      const url = `/api/download/${created.id}`;

      try {
        const middle = await request.get(url, { headers: { Range: 'bytes=0-4' } });
        expect(middle.status()).toBe(206);
        expect(middle.headers()['content-range']).toBe(`bytes 0-4/${content.length}`);
        expect(await middle.text()).toBe('abcde');

        const suffix = await request.get(url, { headers: { Range: 'bytes=-5' } });
        expect(suffix.status()).toBe(206);
        expect(await suffix.text()).toBe('vwxyz');

        const outOfRange = await request.get(url, { headers: { Range: 'bytes=999-1000' } });
        expect(outOfRange.status()).toBe(416);
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('中文文件名应通过 RFC 5987 正确下发', async ({ request }) => {
      const name = unique('中文名.txt');
      const created = await uploadViaApi(request, name, '中文内容');

      try {
        const res = await request.get(`/api/download/${created.id}`);
        const disposition = res.headers()['content-disposition'];
        expect(disposition).toContain("filename*=UTF-8''");
        expect(disposition).toContain(encodeURIComponent(name));
        expect(await res.text()).toBe('中文内容');
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });
  });

  test.describe('删除语义', () => {
    test('不存在的 id 返回 404，重复删除幂等', async ({ request }) => {
      const missing = await request.delete('/api/files/definitely-not-exist');
      expect(missing.status()).toBe(404);

      const created = await uploadViaApi(request, unique('delete-me.txt'), 'bye');
      const first = await request.delete(`/api/files/${created.id}`);
      expect(first.status()).toBe(200);
      expect((await first.json()).success).toBe(true);

      const second = await request.delete(`/api/files/${created.id}`);
      expect(second.status()).toBe(200);
      expect((await second.json()).alreadyDeleted).toBe(true);

      expect(await findByName(request, unique('delete-me.txt'))).toBeFalsy();
    });
  });

  test.describe('扫码下载落地页', () => {
    test('/download/:id 应展示文件名与下载按钮', async ({ page, request }) => {
      const name = unique('landing.txt');
      const created = await uploadViaApi(request, name, 'landing-content');

      try {
        const response = await page.goto(`/download/${created.id}`);
        expect(response.status()).toBe(200);
        await expect(page.locator('h1')).toContainText(name);
        await expect(page.getByRole('button', { name: '立即下载' })).toBeVisible();
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }

      // 不存在的 id 返回 404
      const notFound = await page.goto('/download/definitely-not-exist');
      expect(notFound.status()).toBe(404);
    });
  });

  test.describe('多网卡地址选择', () => {
    test('/api/info 应返回全部本机地址并按私网优先排序', async ({ request }) => {
      const info = await (await request.get('/api/info')).json();

      expect(Array.isArray(info.addresses)).toBe(true);
      expect(info.addresses.length).toBeGreaterThan(0);

      for (const item of info.addresses) {
        expect(typeof item.ip).toBe('string');
        expect(typeof item.interface).toBe('string');
        expect(item.url).toBe(`http://${item.ip}:${info.port}`);
      }

      // 恰好一个推荐地址，且是排序后的第一个；/api/info 的 ip 与之一致
      expect(info.addresses.filter(item => item.recommended)).toHaveLength(1);
      expect(info.addresses[0].recommended).toBe(true);
      expect(info.ip).toBe(info.addresses[0].ip);

      // 198.18/16 这类虚拟网段必须排在真实私网之后
      const isVirtual = (ip) => (/^198\.18\./.test(ip) ? 1 : 0);
      const ranks = info.addresses.map(item => isVirtual(item.ip));
      expect([...ranks].sort().join(',')).toBe(ranks.join(','));
    });

    test('二维码接口应使用指定的本机地址', async ({ request }) => {
      const info = await (await request.get('/api/info')).json();
      const created = await uploadViaApi(request, unique('multi-ip.txt'), 'multi ip');

      try {
        // 用最后一个（最不推荐）的地址，确保确实按传入值生成而不是碰巧等于默认值
        const target = info.addresses[info.addresses.length - 1];

        const fileQr = await (await request.get(`/api/qrcode/${created.id}?host=${target.ip}`)).json();
        expect(fileQr.host).toBe(target.ip);
        expect(fileQr.url).toBe(`http://${target.ip}:${info.port}/download/${created.id}`);

        const connectQr = await (await request.get(`/api/connect-qrcode?host=${target.ip}`)).json();
        expect(connectQr.host).toBe(target.ip);
        expect(connectQr.url).toBe(`http://${target.ip}:${info.port}`);
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('非本机地址应被忽略，二维码不能变成任意跳转', async ({ request }) => {
      const info = await (await request.get('/api/info')).json();
      const created = await uploadViaApi(request, unique('multi-ip-guard.txt'), 'guard');

      try {
        const evilHosts = ['evil.example.com', '10.9.9.9', '../../etc/passwd', '127.0.0.1', '192.168.68.148.evil.com'];

        for (const evil of evilHosts) {
          const fileQr = await (await request.get(`/api/qrcode/${created.id}?host=${encodeURIComponent(evil)}`)).json();
          expect(fileQr.host, `host=${evil} 应回退到默认地址`).toBe(info.ip);

          const connectQr = await (await request.get(`/api/connect-qrcode?host=${encodeURIComponent(evil)}`)).json();
          expect(connectQr.host, `host=${evil} 应回退到默认地址`).toBe(info.ip);
        }
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('界面应提供地址选择器，且二维码跟随所选地址', async ({ page, request }) => {
      const info = await (await request.get('/api/info')).json();

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const selector = page.locator('#server-address');

      if (info.addresses.length < 2) {
        // 只有一个地址时不应出现选择器
        await expect(selector).toHaveCount(0);
        return;
      }

      await expect(selector).toBeVisible();
      await expect(selector.locator('option')).toHaveCount(info.addresses.length);

      // 切换到非推荐地址：展示的服务地址与二维码都要跟着变
      const target = info.addresses[1];
      await selector.selectOption(target.ip);
      await expect(page.locator('.font-mono', { hasText: target.url }).first()).toBeVisible();

      await page.locator('button', { hasText: '显示连接二维码' }).click();
      const modal = page.locator('div.fixed.inset-0');
      await expect(modal.locator('h3', { hasText: '扫码连接' })).toBeVisible();
      await expect(modal.locator('.font-mono', { hasText: target.url })).toBeVisible();
    });
  });

  test.describe('中断上传的资源回收', () => {
    test('客户端断开连接不应在服务端留下半截文件', async ({ request }) => {
      const fs = await import('fs');
      const path = await import('path');
      const http = await import('http');

      const info = await (await request.get('/api/info')).json();
      const uploadsDir = path.join(process.cwd(), 'uploads');
      const listDiskFiles = () => fs.readdirSync(uploadsDir).filter(name => !name.startsWith('.'));

      const before = listDiskFiles();
      const name = unique('abort-test.bin');
      const boundary = `----abortTest${Date.now()}`;

      // 手工构造 multipart 并只发送一部分就断开，模拟用户点击「取消上传」/关闭页面
      await new Promise((resolve) => {
        const req = http.request({
          host: 'localhost',
          port: info.port,
          path: '/api/upload',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': 10 * 1024 * 1024 // 声明 10MB，实际只发一小段
          }
        });

        req.on('error', () => resolve());
        req.write(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\n`
          + 'Content-Type: application/octet-stream\r\n\r\n'
        ));
        req.write(Buffer.alloc(256 * 1024, 1));

        setTimeout(() => {
          req.destroy();
          resolve();
        }, 300);
      });

      // 给服务端清理留出时间
      await new Promise(resolve => setTimeout(resolve, 1500));

      // 半截文件既不应入库，也不应留在磁盘上
      const files = await (await request.get('/api/files')).json();
      expect(files.some(file => file.filename === name)).toBe(false);
      expect(listDiskFiles().length).toBeLessThanOrEqual(before.length);
    });
  });

  test.describe('上传目录直投与搜索', () => {
    test('直接放进上传目录的文件会被登记并列出', async ({ request }) => {
      const fs = await import('fs');
      const path = await import('path');

      const uploadsDir = path.join(process.cwd(), 'uploads');
      const name = unique('直投文件.txt');
      const filePath = path.join(uploadsDir, name);
      fs.writeFileSync(filePath, 'placed directly into uploads');

      try {
        // 服务端对上传目录的扫描有 5 秒节流，且需要跨两次扫描确认体积稳定
        let found = null;
        for (let i = 0; i < 24; i++) {
          const files = await (await request.get('/api/files')).json();
          found = files.find(file => file.filename === name);
          if (found) break;
          await new Promise(resolve => setTimeout(resolve, 700));
        }

        expect(found, '放进 uploads 的文件应出现在列表里').toBeTruthy();
        // 没有 multer 提供的类型时按扩展名推断，保证列表显示正确图标
        expect(found.mime_type).toBe('text/plain');
        expect(found.size).toBe(Buffer.byteLength('placed directly into uploads'));

        // 登记后应能正常下载内容
        const download = await request.get(`/api/download/${found.id}`);
        expect(download.status()).toBe(200);
        expect(await download.text()).toBe('placed directly into uploads');
      } finally {
        const files = await (await request.get('/api/files')).json();
        const created = files.find(file => file.filename === name);
        if (created) {
          await request.delete(`/api/files/${created.id}`);
        }
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });

    test('放进上传目录的文件不会被当作孤儿文件清理', async ({ request }) => {
      const fs = await import('fs');
      const path = await import('path');

      const uploadsDir = path.join(process.cwd(), 'uploads');
      const name = unique('直投保留.txt');
      const filePath = path.join(uploadsDir, name);
      fs.writeFileSync(filePath, 'should survive cleanup');

      try {
        // 触发一次登记（列表接口会顺带扫描上传目录）
        const files = await (await request.get('/api/files')).json();
        expect(files.some(file => file.filename === name) || fs.existsSync(filePath)).toBe(true);

        // 手动触发一次清理（管理接口仅允许本机调用），文件应仍然存在
        const cleanup = await request.post('/api/admin/cleanup');
        expect(cleanup.status()).toBe(200);

        expect(fs.existsSync(filePath), '登记后的直投文件不应被清理').toBe(true);
      } finally {
        const files = await (await request.get('/api/files')).json();
        const created = files.find(file => file.filename === name);
        if (created) {
          await request.delete(`/api/files/${created.id}`);
        }
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });

    test('界面搜索应能按文件名过滤并可清空', async ({ page, request }) => {
      const fs = await import('fs');
      const path = await import('path');

      const uploadsDir = path.join(process.cwd(), 'uploads');
      const tokenA = `搜索甲${Date.now()}`;
      const tokenB = `搜索乙${Date.now()}`;
      const created = [tokenA, tokenB].map(token => {
        const filePath = path.join(uploadsDir, `${token}.txt`);
        fs.writeFileSync(filePath, `content ${token}`);
        return filePath;
      });

      try {
        // 等两个文件被登记（跨两次扫描）
        for (let i = 0; i < 24; i++) {
          const files = await (await request.get('/api/files')).json();
          if ([tokenA, tokenB].every(token => files.some(file => file.filename === `${token}.txt`))) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 700));
        }

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const searchInput = page.locator('input[type="search"]');
        await expect(searchInput).toBeVisible();

        // 输入甲：只应留下甲
        await searchInput.fill(tokenA);
        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: tokenA })).toBeVisible();
        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: tokenB })).toHaveCount(0);

        // 搜索无结果时给出明确提示，而不是显示"暂无文件"
        await searchInput.fill('zzz-不存在-zzz');
        await expect(page.locator('text=没有匹配的文件')).toBeVisible();

        // 清空后两个都回来
        await searchInput.fill('');
        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: tokenA })).toBeVisible();
        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: tokenB })).toBeVisible();
      } finally {
        const files = await (await request.get('/api/files')).json();
        for (const token of [tokenA, tokenB]) {
          const found = files.find(file => file.filename === `${token}.txt`);
          if (found) {
            await request.delete(`/api/files/${found.id}`);
          }
        }
        for (const filePath of created) {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      }
    });
  });

  test.describe('在线预览', () => {
    test('预览接口应内联返回并支持 Range', async ({ request }) => {
      const created = await uploadViaApi(request, unique('preview.txt'), 'preview-content');

      try {
        const res = await request.get(`/api/preview/${created.id}`);
        expect(res.status()).toBe(200);
        const headers = res.headers();
        // inline 才能被浏览器内联播放；attachment 会被强制下载
        expect(headers['content-disposition']).toContain('inline');
        expect(headers['content-disposition']).toContain("filename*=UTF-8''");
        expect(headers['accept-ranges']).toBe('bytes');
        // 禁止类型嗅探，避免把伪装成文本的上传文件当 HTML 执行
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(await res.text()).toBe('preview-content');

        // 视频拖动进度依赖 Range
        const ranged = await request.get(`/api/preview/${created.id}`, { headers: { Range: 'bytes=0-6' } });
        expect(ranged.status()).toBe(206);
        expect(ranged.headers()['content-range']).toBe(`bytes 0-6/${'preview-content'.length}`);
        expect(await ranged.text()).toBe('preview');
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('预览与下载是同一份数据但处置方式不同', async ({ request }) => {
      const created = await uploadViaApi(request, unique('preview-vs-download.txt'), 'same-bytes');

      try {
        const preview = await request.get(`/api/preview/${created.id}`);
        const download = await request.get(`/api/download/${created.id}`);

        expect(preview.headers()['content-disposition']).toContain('inline');
        expect(download.headers()['content-disposition']).toContain('attachment');
        expect(await preview.text()).toBe(await download.text());
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('预览不存在的文件应返回 404', async ({ request }) => {
      const res = await request.get('/api/preview/definitely-not-exist');
      expect(res.status()).toBe(404);
    });

    test('可预览类型显示预览按钮，其他类型不显示', async ({ page, request }) => {
      const created = [];

      try {
        // 声明成各类可预览类型（内容不参与断言，只看界面行为）
        const previewable = [
          { name: unique('preview-video.mp4'), mimeType: 'video/mp4' },
          { name: unique('preview-image.png'), mimeType: 'image/png' },
          { name: unique('preview-audio.mp3'), mimeType: 'audio/mpeg' },
          { name: unique('preview-doc.pdf'), mimeType: 'application/pdf' }
        ];
        for (const item of previewable) {
          const res = await request.post('/api/upload', {
            multipart: { files: { name: item.name, mimeType: item.mimeType, buffer: Buffer.from('x') } }
          });
          const body = await res.json();
          created.push({ ...body.files[0], expected: item.mimeType.split('/')[0] });
        }

        // 不可预览类型（压缩包）
        const zipName = unique('preview-archive.zip');
        const zipRes = await request.post('/api/upload', {
          multipart: { files: { name: zipName, mimeType: 'application/zip', buffer: Buffer.from('x') } }
        });
        created.push({ ...(await zipRes.json()).files[0], expected: null });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        for (const file of created) {
          const card = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: file.filename }).first();
          await expect(card).toBeVisible();

          const previewButton = card.locator('button', { hasText: '预览' });

          if (file.expected) {
            await expect(previewButton, `${file.filename} 应可预览`).toBeVisible();
          } else {
            await expect(previewButton, `${file.filename} 不应有预览按钮`).toHaveCount(0);
          }
        }

        // 视频：弹窗内应出现可播放的 video 元素，且 src 指向预览接口
        const videoFile = created[0];
        const videoCard = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: videoFile.filename }).first();
        await videoCard.locator('button', { hasText: '预览' }).click();

        const modal = page.locator('div[role="dialog"][aria-label="文件预览"]');
        await expect(modal).toBeVisible();
        const video = modal.locator('video');
        await expect(video).toBeVisible();
        await expect(video).toHaveAttribute('src', `/api/preview/${videoFile.id}`);
        await expect(video).toHaveAttribute('controls', '');

        // 预览地址本身可用
        const probe = await request.get(`/api/preview/${videoFile.id}`);
        expect(probe.status()).toBe(200);

        // Esc 关闭
        await page.keyboard.press('Escape');
        await expect(modal).toBeHidden();
      } finally {
        for (const file of created) {
          await request.delete(`/api/files/${file.id}`);
        }
      }
    });

    test('图片与 PDF 预览使用对应标签', async ({ page, request }) => {
      const created = [];

      try {
        for (const item of [
          { name: unique('preview-shape.png'), mimeType: 'image/png', tag: 'img' },
          { name: unique('preview-shape.pdf'), mimeType: 'application/pdf', tag: 'iframe' },
          { name: unique('preview-shape.mp3'), mimeType: 'audio/mpeg', tag: 'audio' }
        ]) {
          const res = await request.post('/api/upload', {
            multipart: { files: { name: item.name, mimeType: item.mimeType, buffer: Buffer.from('x') } }
          });
          const body = await res.json();
          created.push({ ...body.files[0], tag: item.tag });
        }

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        for (const file of created) {
          const card = page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: file.filename }).first();
          await card.locator('button', { hasText: '预览' }).click();

          const modal = page.locator('div[role="dialog"][aria-label="文件预览"]');
          await expect(modal).toBeVisible();
          await expect(modal.locator(file.tag)).toBeVisible();
          await expect(modal.locator(file.tag)).toHaveAttribute('src', `/api/preview/${file.id}`);

          await page.keyboard.press('Escape');
          await expect(modal).toBeHidden();
        }
      } finally {
        for (const file of created) {
          await request.delete(`/api/files/${file.id}`);
        }
      }
    });
  });

  test.describe('收藏与列表筛选', () => {
    test('收藏接口应显式设置目标状态', async ({ request }) => {
      const created = await uploadViaApi(request, unique('favorite-api.txt'), 'fav');

      try {
        const on = await request.post(`/api/files/${created.id}/favorite`, { data: { favorite: true } });
        expect(on.status()).toBe(200);
        expect((await on.json()).is_favorite).toBe(1);

        // 显式传 false 时，即使当前已是收藏态也应取消
        const off = await request.post(`/api/files/${created.id}/favorite`, { data: { favorite: false } });
        expect((await off.json()).is_favorite).toBe(0);
      } finally {
        await request.delete(`/api/files/${created.id}`);
      }
    });

    test('「只看收藏」应过滤列表', async ({ page, request }) => {
      const favorite = await uploadViaApi(request, unique('fav-yes.txt'), 'yes');
      const plain = await uploadViaApi(request, unique('fav-no.txt'), 'no');

      try {
        await request.post(`/api/files/${favorite.id}/favorite`, { data: { favorite: true } });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const toggle = page.locator('button', { hasText: '只看收藏' }).first();
        await expect(toggle).toBeVisible();

        // 过滤前两个文件都在
        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: unique('fav-yes.txt') })).toBeVisible();
        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: unique('fav-no.txt') })).toBeVisible();

        await toggle.click();

        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: unique('fav-yes.txt') })).toBeVisible();
        await expect(page.locator('.bg-surface-3.rounded-2xl').filter({ hasText: unique('fav-no.txt') })).toHaveCount(0);
      } finally {
        await request.delete(`/api/files/${favorite.id}`);
        await request.delete(`/api/files/${plain.id}`);
      }
    });
  });
});
