/**
 * 页面级目录快照与会话管理。
 *
 * 基于 chrome.storage.local 持久化页面级目录路径和快照标记，
 * 按「页面业务实例唯一标识（pageId）+ pageType」区分不同页面。
 *
 * pageId 不使用「路由地址」（URL 可能携带 token/时间戳等动态 query，
 * 导致同一业务实例每次打开 URL 不同、无法命中已保存路径），
 * 而是从 URL 提取稳定的业务实例标识：
 * - 云枢：applicationCode/formCode（model=应用编码/表单编码）
 * - 氚云：设计器 id
 * 由此形成 pageId → 目录路径 的一一对应。
 */

import { normalizePath } from '../lib/utils.js';
import { FNV1A_OFFSET_BASIS, FNV1A_PRIME, PAGE_TYPE_DEFAULT } from '../lib/constants.js';
import { parseModelCodesFromPageUrl } from '../lib/platform/readme-parser.js';
import { extractH3yunDesignerId } from '../lib/platform/h3yun-code.js';

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

/**
 * 从 URL 提取页面业务实例标识（pageId）。
 * 优先取稳定的业务实例标识；取不到时退回 URL pathname 特征（排除动态 query）。
 */
function buildPageInstanceId(pageUrl: string, pageType: string): string {
  const normalizedPageType = normalizePageType(pageType);

  // 氚云：以设计器 id 作为业务实例标识
  if (normalizedPageType.startsWith('h3yun')) {
    const designerId = extractH3yunDesignerId(pageUrl);
    if (designerId) return `h3:${hashScopePart(designerId)}`;
  } else {
    // 云枢：以 applicationCode/formCode 作为业务实例标识
    const { applicationCode, formCode } = parseModelCodesFromPageUrl(pageUrl);
    if (applicationCode || formCode) {
      return `model:${hashScopePart(`${applicationCode}/${formCode}`)}`;
    }
  }

  // 兜底：无法提取业务实例标识时，退回 pathname 特征（排除 token/时间戳等动态 query）
  return `url:${hashScopePart(extractStablePathPart(pageUrl))}`;
}

/** 提取 URL 稳定路径部分（仅 pathname，排除动态 query / hash） */
function extractStablePathPart(pageUrl: string): string {
  try {
    return new URL(pageUrl).pathname;
  } catch {
    return String(pageUrl || '');
  }
}

/**
 * 为具体页面生成稳定目录 scope（按「页面业务实例标识」隔離，不含 tabId）。
 *
 * 关键：pageId 使用业务实例唯一标识（表单编码 / 设计器 id），
 * 而非「路由地址」整条 URL。这样：
 * - 同一表单设计器打开不同表单（表单A / 表单B）会产生不同 pageId，互不串用；
 * - URL 携带 token/时间戳等动态参数时，同一业务实例仍命中同一 scope，
 *   刷新 / 重开标签页后依旧恢复该页面之前保存的目录路径。
 */
export function createTargetDirectoryPageScope(tab: TabInfo | number, pageType: string): string {
  const pageUrl = typeof tab === 'object' ? (tab.url || tab.pendingUrl || '') : '';
  const normalizedPageType = normalizePageType(pageType);

  if (pageUrl) {
    return `page:${normalizedPageType}:${buildPageInstanceId(pageUrl, normalizedPageType)}`;
  }

  // 兜底：无 URL（仅 tabId）时按标签维度隔离
  const tabId = typeof tab === 'object' ? (tab.id ?? tab.tabId) : tab;
  const normalizedTabId = String(tabId ?? '').trim();
  return normalizedTabId ? `tab:${normalizedTabId}:${normalizedPageType}` : '';
}

// ── 公开 API ──────────────────────────────────────────

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
