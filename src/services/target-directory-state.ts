/**
 * 目录选择与路径解析状态聚合。
 *
 * 三级回退逻辑：
 *  1) 页面级快照（scope 精确匹配当前 tab+URL）
 *  2) 全局页类型默认（同一 pageType 共享）
 *  3) 平台兜底路径（云枢 / 氚云 fallback）
 *
 * 管理 Handle 通道的目录句柄状态。
 */

import { logger } from '../lib/logger.js';
import { normalizePath } from '../lib/utils.js';
import { createTargetDirectoryPageScope, getTargetDirectoryPathByScope, saveTargetDirectoryPathByScope, clearTargetDirectoryPathsByScopePrefix, clearTargetDirectorySnapshotsByScopePrefix } from './target-directory-session.js';
import { getTargetDirectoryHandle, getTargetDirectoryHandleForScope, clearTargetDirectoryHandleForScope, saveTargetDirectoryHandle, clearTargetDirectoryHandlesByScopePrefix } from '../lib/directory/file-handle-db.js';
import {
  loadConfig,
  getTargetDirectoryPathByPageType,
  saveTargetDirectoryPathByPageType,
  getFallbackDirectoryPathByPlatform,
  getPlatformKeyFromPageType,
} from './config.js';
import { mergeRecentTargetDirectories, normalizeRecentTargetDirectories, addRecentTargetDirectory } from './recent-target-directories.js';
import { getLastDirectorySelection, saveLastDirectorySelection } from './last-directory.js';
import type { PlatformKey } from '../types/platform.js';

// ── 内部工具 ──────────────────────────────────────────

// ── Handle 通道状态管理 ───────────────────────────────

interface HandleState {
  readonly handleModeSelected: boolean;
  readonly path: string;
  readonly label: string;
}

async function getHandleState(pageType: string): Promise<HandleState> {
  try {
    const handle = await getTargetDirectoryHandle(pageType);
    if (handle) {
      return { handleModeSelected: true, path: '', label: handle.name || '' };
    }
  } catch (_error: unknown) {
    logger.warn('Failed to get target directory handle', { pageType });
  }
  return { handleModeSelected: false, path: '', label: '' };
}

// ── 三级回退路径解析 ──────────────────────────────────

interface TabInfo {
  readonly id?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
}

/**
 * 按 scope 三级回退获取页面已绑定目录路径：
 * scope → pageType 全局默认 → 平台 fallback
 */
export async function getStoredDirectoryPath(
  tab: TabInfo | number,
  pageType: string,
): Promise<string> {
  const pageScope = createTargetDirectoryPageScope(tab, pageType);

  // 1) 页面级快照
  const scopedPath = await getTargetDirectoryPathByScope(pageScope);
  if (scopedPath) return scopedPath;

  // 2) 全局页类型默认
  const pageTypePath = await getTargetDirectoryPathByPageType(pageType);
  if (pageTypePath) {
    // 同时为此页面建立快照
    await saveTargetDirectoryPathByScope(pageScope, pageTypePath);
    return pageTypePath;
  }

  // 3) 全局上次选择目录（跨页面 / 跨平台共享，优先于设置里的默认目录）
  const lastSelection = await getLastDirectorySelection();
  if (lastSelection) {
    await saveTargetDirectoryPathByScope(pageScope, lastSelection.label);
    return lastSelection.label;
  }

  // 4) 平台兜底路径
  const config = await loadConfig();
  const platformKey = getPlatformKeyFromPageType(pageType) as PlatformKey;
  const fallbackPath = getFallbackDirectoryPathByPlatform(config, platformKey);
  if (fallbackPath) {
    await saveTargetDirectoryPathByScope(pageScope, fallbackPath);
  }
  return fallbackPath;
}

// ── 选择目录后同步落库 ────────────────────────────────

/**
 * 选择 Handle 目录后同步存储：
 * - global: save → 更新页类型全局 Handle + 清空路径状态
 */
export async function saveHandleSelection(
  handle: FileSystemDirectoryHandle,
  tab: TabInfo | number,
  pageType = 'default',
): Promise<HandleState> {
  const pageScope = createTargetDirectoryPageScope(tab, pageType);

  // 保存 Handle 到页类型全局
  await saveTargetDirectoryHandle(handle, pageType);

  // 清空路径通道的旧状态（反冗余）
  await saveTargetDirectoryPathByPageType(pageType, '');

  const label = handle.name || '';
  await addRecentTargetDirectory(label, pageType);
  // 记录全局「上次选择目录」，跨页面 / 跨平台共享，避免下次回退到默认目录
  await saveLastDirectorySelection(label, pageType);

  return { handleModeSelected: true, path: '', label };
}

/**
 * 解析当前有效的目录句柄（跨页面共享）。
 * 回退顺序：
 *  1) 当前 pageType 全局句柄
 *  2) 全局上次选择目录对应的 pageType 句柄（跨页面 / 跨平台兜底）
 *  3) 页面级 scope 句柄
 */
export async function resolveTargetDirectoryHandle(
  tab: TabInfo | number,
  pageType: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  // 1) 当前 pageType 全局句柄
  const handle = await getTargetDirectoryHandle(pageType);
  if (handle) return handle;

  // 2) 全局上次选择目录的 pageType 句柄（跨页面共享）
  const lastSelection = await getLastDirectorySelection();
  if (lastSelection && lastSelection.pageType !== pageType) {
    const lastHandle = await getTargetDirectoryHandle(lastSelection.pageType);
    if (lastHandle) return lastHandle;
  }

  // 3) 页面级 scope 句柄
  const pageScope = createTargetDirectoryPageScope(tab, pageType);
  if (pageScope) {
    const scopedHandle = await getTargetDirectoryHandleForScope(pageScope);
    if (scopedHandle) return scopedHandle;
  }

  return undefined;
}

// ── 标签页关闭清理 ────────────────────────────────────

/**
 * 标签页关闭时清理该 tabId 下的所有存储项。
 * 覆盖：Handle、路径、快照标记。
 */
export async function clearTabTargetDirectoryData(
  tabId: number,
  pageType = 'default',
): Promise<void> {
  const suffix = `${normalizePath(pageType)}:`;

  // 清理 Handle 通道数据
  await clearTargetDirectoryHandlesByScopePrefix(`tab:${tabId}:`);
  // 清理 Handle 通道页面级句柄
  await clearTargetDirectoryHandleForScope(`tab:${tabId}:`);
  // 清理路径通道
  await clearTargetDirectoryPathsByScopePrefix(`tab:${tabId}:${suffix}`);
  // 清理快照标记
  await clearTargetDirectorySnapshotsByScopePrefix(`tab:${tabId}:${suffix}`);

  logger.debug('Cleared target directory data for tab', { tabId, pageType });
}
