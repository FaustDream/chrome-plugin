/**
 * Background Service Worker —— 扩展单一可信源。
 *
 * 职责：
 * - 标签页生命周期管理（建立/清理目录快照）
 * - 配置变更监听
 *
 * 约束：状态不写入模块级可变变量（用 chrome.storage 替代）。
 */
import { resolvePageTypeConfig } from '../services/config.js';
import { cleanupLegacyDirectoryData } from '../services/target-directory-state.js';
import { logger } from '../lib/logger.js';
import { createPageScope } from '../lib/utils.js';
import type { PageType } from '../types/platform.js';

// ── 工具 ──────────────────────────────────────────────

function getTabPageUrl(tab: chrome.tabs.Tab): string {
  return String(tab?.url || tab?.pendingUrl || '').trim();
}

// ── 目录快照 ──────────────────────────────────────────

/** 标签页创建或跳转时建立目录快照 */
async function snapshotTabTargetDirectory(tabId: number | undefined, tab: chrome.tabs.Tab): Promise<void> {
  if (tabId === undefined) return;
  const pageUrl = getTabPageUrl(tab);
  if (!pageUrl) return;

  const pageTypeConfig = resolvePageTypeConfig(pageUrl);
  if (!pageTypeConfig) return;

  const pageType = pageTypeConfig.pageType;
  const pageScope = createPageScope(pageTypeConfig.platformKey, pageType, pageUrl);

  // 确保快照存在（不覆盖已有数据）
  await ensureSnapshotExists(pageType, pageScope);
  logger.debug('Directory snapshot created', { scope: pageScope, pageType });
}

async function ensureSnapshotExists(pageType: PageType, scope: string): Promise<void> {
  const key = `targetDirectorySnapshot:${scope}`;
  const existing = await chrome.storage.local.get(key);
  if (!existing[key]) {
    await chrome.storage.local.set({
      [key]: { pageType, scope, createdAt: Date.now() },
    });
  }
}

function snapshotTabSafe(tabId: number, tab: chrome.tabs.Tab): void {
  snapshotTabTargetDirectory(tabId, tab).catch((err: unknown) => {
    logger.warn('Snapshot tab target directory failed', { error: String(err) });
  });
}

/** 扩展启动时为已有标签页建立基线快照 */
async function snapshotExistingTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => snapshotTabTargetDirectory(tab.id, tab)));
}

// ── 清理目录快照 ─────────────────────────────────────

async function clearTabSnapshots(tabId: number): Promise<void> {
  const scopePrefix = `tab:${tabId}:`;
  const allKeys = await chrome.storage.local.get(null);
  const keysToRemove: string[] = [];

  for (const key of Object.keys(allKeys)) {
    if (key.startsWith('targetDirectorySnapshot:') && key.includes(scopePrefix)) {
      keysToRemove.push(key);
    }
    if (key.startsWith('targetDirectoryPath:') && key.includes(scopePrefix)) {
      keysToRemove.push(key);
    }
    if (key.startsWith('targetDirectory:') && key.includes(scopePrefix)) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// ── 事件注册 ──────────────────────────────────────────

function bootstrapExtension(): void {
  snapshotExistingTabs().catch((err: unknown) => {
    logger.warn('Snapshot existing tabs failed', { error: String(err) });
  });
  // 旧共享槽迁移清洗（幂等）：删除 pageType 全局句柄 / LAST_DIRECTORY / 假 scope 快照
  cleanupLegacyDirectoryData().catch((err: unknown) => {
    logger.warn('Legacy directory cleanup failed', { error: String(err) });
  });
}

chrome.runtime.onInstalled.addListener(bootstrapExtension);
chrome.runtime.onStartup.addListener(bootstrapExtension);

chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab) => {
  snapshotTabSafe(tab.id ?? -1, tab);
});

chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
  if (!changeInfo.url && !getTabPageUrl(tab)) return;
  snapshotTabSafe(tabId, tab);
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  clearTabSnapshots(tabId).catch((err: unknown) => {
    logger.warn('Clear tab snapshots failed', { tabId, error: String(err) });
  });
});

logger.info('Background Service Worker initialized');