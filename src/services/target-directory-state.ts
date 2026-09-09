/**
 * 目录选择与句柄解析状态（仅页面 scope 记忆）。
 *
 * 新版语义（替代旧版三级回退）：
 * - 目录记忆粒度 = 页面业务实例(scope)，页面间永不串用；
 * - 新页面(无 scope 绑定)强制手动选择「更新当前路径」或从历史恢复，
 *   不再自动绑定任何全局/平台级"上次选择目录"；
 * - 展示路径与读写句柄均以 scope 句柄为唯一权威，杜绝显示/写入不一致；
 * - 旧共享槽（pageType 全局句柄、平台 LAST_DIRECTORY）已整体退役，
 *   通过 cleanupLegacyDirectoryData() 在扩展启动时清理。
 */

import { logger } from '../lib/logger.js';
import { STORAGE_KEYS } from '../lib/constants.js';
import { createTargetDirectoryPageScope, saveTargetDirectoryPathByScope, clearTargetDirectoryPathsByScopePrefix, clearTargetDirectorySnapshotsByScopePrefix } from './target-directory-session.js';
import { getTargetDirectoryHandleForScope, clearTargetDirectoryHandleForScope, saveTargetDirectoryHandleForScope, clearTargetDirectoryHandlesByScopePrefix, clearAllTargetDirectoryHandles } from '../lib/directory/file-handle-db.js';
import { addRecentTargetDirectory } from './recent-target-directories.js';

interface TabInfo {
  readonly id?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
}

// ── 仅 scope 路径解析 ───────────────────────────────

/**
 * 获取页面当前绑定目录的展示路径（目录名）。
 *
 * 只认 page scope 句柄（权威）：句柄存在即返回其目录名；否则返回 ''，
 * 不经过任何全局/平台回退，保证「展示 = 写入」。
 */
export async function getStoredDirectoryPath(
  tab: TabInfo | number,
  _pageType: string,
): Promise<string> {
  const pageScope = createTargetDirectoryPageScope(tab, _pageType);
  if (!pageScope) return '';

  const scopeHandle = await getTargetDirectoryHandleForScope(pageScope);
  return scopeHandle?.name || '';
}

// ── 选择目录后同步落库 ────────────────────────────────

/**
 * 选择 Handle 目录后绑定到当前页面 scope：
 * - 仅写「页面级句柄 + 页面级路径 + 最近使用历史」，不写任何全局/平台共享槽
 *   （旧版会覆盖 pageType 全局句柄与 LAST_DIRECTORY，导致多页面互相污染）。
 * - 展示与读写均通过 scope 句柄解析，后续不会被其他页面的选择覆盖。
 */
export async function saveHandleSelection(
  handle: FileSystemDirectoryHandle,
  tab: TabInfo | number,
  pageType = 'default',
): Promise<{ handleModeSelected: boolean; path: string; label: string }> {
  const pageScope = createTargetDirectoryPageScope(tab, pageType);

  const label = handle.name || '';
  await addRecentTargetDirectory(label, pageType, pageScope || undefined);
  if (pageScope) {
    // 绑定页面级句柄 + 路径快照（目录名）
    await saveTargetDirectoryHandleForScope(handle, pageScope);
    await saveTargetDirectoryPathByScope(pageScope, label);
  }

  return { handleModeSelected: true, path: '', label };
}

/**
 * 解析当前页面已绑定的目录句柄。
 * 回退顺序与 getStoredDirectoryPath（展示）保持一致：
 *  1) 当前页面的 scope 句柄（唯一来源）
 *  2) 无 → undefined（页面未绑定，写入方上报「请先选择目录」）
 *
 * 关键：不再回退到 页类型全局句柄 / 平台上次选择目录，
 * 避免页面 A 被页面 B 最后选择的目录覆盖（旧版污染根源）。
 */
export async function resolveTargetDirectoryHandle(
  tab: TabInfo | number,
  pageType: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  const pageScope = createTargetDirectoryPageScope(tab, pageType);
  if (!pageScope) return undefined;
  return getTargetDirectoryHandleForScope(pageScope);
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
  const suffix = `${String(pageType || '').trim()}:`;

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

// ── 旧共享槽迁移清洗（启动时幂等执行） ─────────────────

/**
 * 清理旧版「共享槽」遗留数据，防止继续污染新逻辑：
 * - IndexedDB：页类型全局句柄（target-directory:<pageType>）
 * - chrome.storage.local：
 *   - LAST_DIRECTORY（平台「上次选择目录」，仅存目录名不可靠）
 *   - targetDirectoryPageTypePaths（页类型全局路径）
 *   - targetDirectoryPagePaths / targetDirectoryPageSnapshots（旧假 scope 路径快照）
 *
 * 保留：页面级 scope 句柄（历史恢复依赖）、平台默认目录句柄、最近使用历史列表。
 * 幂等：数据不存在时删除无副作用。
 */
export async function cleanupLegacyDirectoryData(): Promise<void> {
  try {
    await clearAllTargetDirectoryHandles();
    await chrome.storage.local.remove([
      STORAGE_KEYS.LAST_DIRECTORY,
      'targetDirectoryPageTypePaths',
      'targetDirectoryPagePaths',
      'targetDirectoryPageSnapshots',
    ]);
    logger.info('Cleaned up legacy shared directory slots');
  } catch (error: unknown) {
    logger.warn('Legacy directory cleanup failed', { error: String(error) });
  }
}