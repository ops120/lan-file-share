import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 全量测试收尾清理
 *
 * 测试用例会上传真实文件到服务端的 uploads 目录（其中包含 100MB 级的大文件用例），
 * 并在本机 test_data/ 下生成同名临时文件。若不做统一收尾，每跑一轮就会累积——
 * 实测多轮运行后服务端累积到 874 个文件 / 1.2GB、本地 test_data/ 累积到 909 个文件 / 1.4GB。
 *
 * 这里按「测试用例自身使用的文件名前缀」精确匹配后删除，不会误删用户文件，
 * 也不会动 test_data/ 里原有的测试夹具（large.bin / medium.jpg / small.txt）。
 * 需要在 playwright.config.js 中通过 globalTeardown 注册。
 */

const TEST_FILE_PATTERNS = [
  /^large-file[_-]/,
  /^concurrent[_-]/,
  /^perf-test[_-]/,
  /^memory-test[_-]/,
  /^small-test/,
  /^medium-test/,
  /^multi-test/,
  /^multi-[bc][_-]/,
  /^download-test/,
  /^homepage-list-/,
  /^layout-(desktop|mobile)-/,
  /^api-\d+/,
  /^qr-/,
  /^dbl-tap-/,
  /^fav-(yes|no)-/,
  /^test-favorite/,
  /^test-file[_-]/,
  /^test-mobile/,
  /^ws-reconnect/,
  /^slow-network/,
  /^error-test/,
  /^empty-file/,
  /^duplicate/,
  /^delete-me/,
  /^update(-v2)?\.txt$/,
  /^test_chunk/,
  /^test-image/,
  /^downloaded-test/,
  /^dangerous_/,
  /^resume-result/,
  /^expire-test/,
  /^empty-test/,
  /^large-test/,
  /^cancel-test/,
  /^server-500/,
  /^downloaded-/,
  /^document-/,
  /^hashtest/,
  /^test_chunk_status/,
  /^测试文件-中文/,
  // 独立验收脚本 tests/browser-acceptance.mjs 使用的文件名
  /^验收-(测试文档|后台列表|进度|样例视频)-/,
  /^acceptance-/,
  // 注意：test_data/preview-sample.webm 是验收脚本的样例视频夹具，不能当垃圾清理
  // 特殊字符文件名用例产生的固定前缀
  /^test文件/,
  /^test-file@/,
  /^test file/,
  /^test_under/,
  /^тест-/,
  /^测试-日本語/
];

export function isTestArtifact(filename) {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(filename));
}

// 清理本机 test_data/ 下测试自建的临时文件（用例先本地造文件再上传）
function cleanupLocalScratch() {
  const scratchDir = path.join(__dirname, '..', 'test_data');
  if (!fs.existsSync(scratchDir)) {
    return { removed: 0, freedBytes: 0 };
  }

  let removed = 0;
  let freedBytes = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!isTestArtifact(entry.name)) {
        continue;
      }
      try {
        const size = fs.statSync(full).size;
        fs.unlinkSync(full);
        removed++;
        freedBytes += size;
      } catch (error) {
        // 文件可能已被用例自行清理
      }
    }
  };

  walk(scratchDir);
  return { removed, freedBytes };
}

export default async function globalTeardown() {
  const baseURL = process.env.BASE_URL || 'http://localhost:13080';

  // 1) 清理服务端 uploads 里的测试文件
  try {
    const listed = await fetch(`${baseURL}/api/files`);
    if (listed.ok) {
      const files = await listed.json();

      if (Array.isArray(files)) {
        let removed = 0;
        let freedBytes = 0;

        for (const file of files) {
          if (!isTestArtifact(file.filename)) {
            continue;
          }
          const response = await fetch(`${baseURL}/api/files/${file.id}`, { method: 'DELETE' });
          if (response.ok) {
            removed++;
            freedBytes += file.size || 0;
          }
        }

        if (removed > 0) {
          console.log(
            `[global-teardown] 已清理服务端测试文件 ${removed} 个，释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB`
          );
        }
      }
    }
  } catch (error) {
    // 服务未启动时不阻塞测试结果输出
    console.warn('[global-teardown] 跳过服务端清理:', error.message);
  }

  // 2) 清理本机测试临时文件
  try {
    const { removed, freedBytes } = cleanupLocalScratch();
    if (removed > 0) {
      console.log(
        `[global-teardown] 已清理本机临时文件 ${removed} 个，释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB`
      );
    }
  } catch (error) {
    console.warn('[global-teardown] 跳过本机清理:', error.message);
  }
}
