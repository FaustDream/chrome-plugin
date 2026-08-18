/**
 * 页面级目录快照与会话管理。
 *
 * 基于 chrome.storage.local 持久化页面级目录路径和快照标记，
 * 按 `tabId + pageType + URL hash` 区分不同已打开页面。
 */

import { normalizePath } from '../lib/utils.js';
import { FNV1A_OFFSET_BASIS, FNV1A_PRIME, PAGE_TYPE_DEFAULT, STORAGE_KEYS } from '../lib/constants.js';

// ── 存储键 ────────────────────────────────────────────

const TARGET_DIRECTORY_PAGE_PATHS_KEY = 'targetDirectoryPagePaths';
const TARGET_DIRECTORY_PAGE_SNAPSHOTS_KEY = 'targetDirectoryPageSnapshots';

// ── 内部工具 ──────────────────────────────────────────

function normalizeScopeKey(scopeKey: string): string {
  return String(scopeKey || '').trim();
}

/** FNV-1a hash 用于压缩 URL 路径为短 key */
function hashScopePart(value: string): string {
  let hash = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = (Math.imul(hash, FNV1A_PRIME) >>> 0);
  }
  return hash.toString(36);
}

function normalizePageType(value: string): string {
  return String(value || '').trim() || PAGE_TYPE_DEFAULT;
}

interface ScopedPaths {
  [scopeKey: string]: string;
}

interface ScopedSnapshots {
  [scopeKey: string]: boolean;
}

// ── 存储读写 ──────────────────────────────────────────

function normalizeScopedPaths(value: unknown): ScopedPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const result: ScopedPaths = {};
  for (const [scopeKey, path] of Object.entries(obj)) {
    const key = normalizeScopeKey(scopeKey);
    const p = normalizePath(path);
    if (key && p) result[key] = p;
  }
  return result;
}

async function loadPagePaths(): Promise<ScopedPaths> {
  const stored = await chrome.storage.local.get({ [TARGET_DIRECTORY_PAGE_PATHS_KEY]: {} });
  return normalizeScopedPaths(stored[TARGET_DIRECTORY_PAGE_PATHS_KEY]);
}

async function loadPageSnapshots(): Promise<ScopedSnapshots> {
  const stored = await chrome.storage.local.get({ [TARGET_DIRECTORY_PAGE_SNAPSHOTS_KEY]: {} });
  const snapshots = stored[TARGET_DIRECTORY_PAGE_SNAPSHOTS_KEY];
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) return {};

  const result: ScopedSnapshots = {};
  for (const [scopeKey, exists] of Object.entries(snapshots as Record<string, unknown>)) {
    const key = normalizeScopeKey(scopeKey);
    if (key && exists) result[key] = true;
  }
  return result;
}

// ── Scope 构建 ────────────────────────────────────────

interface TabInfo {
  readonly id?: number;
  readonly tabId?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
}

/** 为标签页中的具体页面生成目录快照 scope */
export function createTargetDirectoryPageScope(tab: TabInfo | number, pageType: string): string {
  const tabId = typeof tab === 'object' ? (tab.id ?? tab.tabId) : tab;
  const pageUrl = typeof tab === 'object' ? (tab.url || tab.pendingUrl || '') : '';
  const normalizedTabId = String(tabId ?? '').trim();
  if (!normalizedTabId) return '';

  return `tab:${normalizedTabId}:${normalizePageType(pageType)}:${hashScopePart(pageUrl)}`;
}

// ── 公开 API ──────────────────────────────────────────

/** 读取页面级绝对路径快照 */
export async function getTargetDirectoryPathByScope(pageScope: string): Promise<string> {
  const key = normalizeScopeKey(pageScope);
  if (!key) return '';

  const paths = await loadPagePaths();
  return normalizePath(paths[key]);
}

/** 判断页面 scope 是否已有快照 */
export async function hasTargetDirectoryScopeSnapshot(pageScope: string): Promise<boolean> {
  const key = normalizeScopeKey(pageScope);
  if (!key) return false;

  const snapshots = await loadPageSnapshots();
  return Boolean(snapshots[key]);
}

/** 标记页面 scope 已完成快照 */
export async function markTargetDirectoryScopeSnapshot(pageScope: string): Promise<void> {
  const key = normalizeScopeKey(pageScope);
  if (!key) return;

  const snapshots = await loadPageSnapshots();
  snapshots[key] = true;
  await chrome.storage.local.set({ [TARGET_DIRECTORY_PAGE_SNAPSHOTS_KEY]: snapshots });
}

/** 保存页面级绝对路径 */
export async function saveTargetDirectoryPathByScope(
  pageScope: string,
  targetDirectoryPath: string,
): Promise<string> {
  const key = normalizeScopeKey(pageScope);
  if (!key) return '';

  const paths = await loadPagePaths();
  const path = normalizePath(targetDirectoryPath);
  if (path) {
    paths[key] = path;
  } else {
    delete paths[key];
  }

  await chrome.storage.local.set({ [TARGET_DIRECTORY_PAGE_PATHS_KEY]: paths });
  await markTargetDirectoryScopeSnapshot(key);
  return path;
}

/** 标签页关闭后按前缀清理路径快照 */
export async function clearTargetDirectoryPathsByScopePrefix(scopePrefix: string): Promise<void> {
  const prefix = normalizeScopeKey(scopePrefix);
  if (!prefix) return;

  const paths = await loadPagePaths();
  const next: ScopedPaths = {};
  for (const [key, value] of Object.entries(paths)) {
    if (!key.startsWith(prefix)) next[key] = value;
  }

  await chrome.storage.local.set({ [TARGET_DIRECTORY_PAGE_PATHS_KEY]: next });
}

/** 标签页关闭后按前缀清理快照标记 */
export async function clearTargetDirectorySnapshotsByScopePrefix(scopePrefix: string): Promise<void> {
  const prefix = normalizeScopeKey(scopePrefix);
  if (!prefix) return;

  const snapshots = await loadPageSnapshots();
  const next: ScopedSnapshots = {};
  for (const [key, exists] of Object.entries(snapshots)) {
    if (!key.startsWith(prefix)) next[key] = exists;
  }

  await chrome.storage.local.set({ [TARGET_DIRECTORY_PAGE_SNAPSHOTS_KEY]: next });
}
