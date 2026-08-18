/**
 * 发布打包脚本：将 dist/ 产物打包为浏览器可侧载的 zip。
 *
 * 用法：node scripts/package.mjs
 * 产物：releases/cloudpiovt-plugin-v<version>.zip
 *
 * zip 根目录直接包含 manifest.json（解压后到 chrome://extensions 开启「开发者模式」→「加载已解压的扩展程序」）。
 * 依赖系统 tar（Windows 10+ / macOS / Linux 均自带，支持 zip 格式）。
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const RELEASES_DIR = resolve(ROOT, 'releases');

async function main() {
  if (!existsSync(DIST)) {
    console.error('[package] dist/ 不存在，请先执行 npm run build');
    process.exit(1);
  }

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const zipPath = join(RELEASES_DIR, `cloudpiovt-plugin-v${version}.zip`);

  await mkdir(RELEASES_DIR, { recursive: true });
  if (existsSync(zipPath)) {
    await rm(zipPath, { force: true });
  }

  // 以 dist 为当前目录打包其全部内容到 zip 根目录（含 manifest.json）
  execSync(`tar -a -c -f "${zipPath}" .`, { cwd: DIST, stdio: 'inherit' });

  console.log(`[package] 打包完成 → ${zipPath}`);
}

main().catch((err) => {
  console.error('[package] 打包失败:', err);
  process.exit(1);
});
