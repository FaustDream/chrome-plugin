/**
 * 构建脚本（Manifest V3 · TypeScript → ESM via esbuild）
 *
 * 职责：
 *   1. 用 esbuild 将 TS 入口打包为 ESM（popup / options / background）
 *   2. 拷贝 HTML / CSS / manifest.json 到 dist
 *   3. 拷贝 assets（图标等）到 dist/assets
 *   4. 支持 --watch 增量构建（dev）
 *
 * 不引入任何运行时 CSS 方案（vanilla-extract 规划中，由 CSS 文件直接处理）。
 */

import { build, context } from 'esbuild';
import { mkdir, cp, rm, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const DIST = resolve(ROOT, 'dist');

/** 入口定义：输出名 → 源码路径 */
const ENTRIES = [
  { in: resolve(SRC, 'pages', 'popup.ts'), out: 'popup' },
  { in: resolve(SRC, 'pages', 'options.ts'), out: 'options' },
  { in: resolve(SRC, 'background', 'background.ts'), out: 'background' },
];

/** 需要原样拷贝的静态资源（相对 src 的路径） */
const STATIC_FILES = [
  { from: resolve(SRC, 'pages', 'popup.html'), to: resolve(DIST, 'popup.html') },
  { from: resolve(SRC, 'pages', 'options.html'), to: resolve(DIST, 'options.html') },
  { from: resolve(ROOT, 'manifest.json'), to: resolve(DIST, 'manifest.json') },
];

/** 需要拷贝的样式文件（相对 src 的路径） */
const STYLE_FILES = [
  { from: resolve(SRC, 'pages', 'popup.css'), to: resolve(DIST, 'popup.css') },
  { from: resolve(SRC, 'pages', 'options.css'), to: resolve(DIST, 'options.css') },
];

const ASSETS_SRC = resolve(ROOT, 'assets');
const ASSETS_DIST = resolve(DIST, 'assets');

/** 公共 esbuild 配置 */
const ESBUILD_BASE = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
};

async function cleanDist() {
  if (existsSync(DIST)) {
    await rm(DIST, { recursive: true, force: true });
  }
  await mkdir(DIST, { recursive: true });
}

async function copyStatic() {
  for (const { from, to } of [...STATIC_FILES, ...STYLE_FILES]) {
    if (!existsSync(from)) {
      console.warn(`[build] 跳过缺失的静态文件: ${from}`);
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function copyAssets() {
  if (!existsSync(ASSETS_SRC)) return;
  await cp(ASSETS_SRC, ASSETS_DIST, { recursive: true });
}

async function runOnce() {
  await cleanDist();
  await copyStatic();
  await copyAssets();

  await build({
    ...ESBUILD_BASE,
    entryPoints: ENTRIES.map((e) => e.in),
    outdir: DIST,
    entryNames: '[name]',
  });

  console.log('[build] 构建完成 → dist/');
}

async function runWatch() {
  // watch 模式下不清空 dist，仅增量重打包 JS；静态资源首次拷贝一次
  await copyStatic();
  await copyAssets();

  const ctx = await context({
    ...ESBUILD_BASE,
    entryPoints: ENTRIES.map((e) => e.in),
    outdir: DIST,
    entryNames: '[name]',
  });
  await ctx.watch();
  console.log('[build] watch 模式已启动，文件变更将自动重打包');
}

const isWatch = process.argv.includes('--watch');

try {
  if (isWatch) {
    await runWatch();
  } else {
    await runOnce();
  }
} catch (err) {
  console.error('[build] 构建失败:', err);
  process.exit(1);
}
