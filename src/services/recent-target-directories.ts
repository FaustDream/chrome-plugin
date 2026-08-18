/**
 * 最近使用目录历史管理。
 *
 * 基于 chrome.storage.local 持久化，不设数量上限，按 path 去重、时间降序排列。
 */
import { STORAGE_KEYS } from '../lib/constants.js';
import { normalizePath } from '../lib/utils.js';

export interface RecentDirectoryEntry {
  readonly path: string;
  readonly pageType: string;
  readonly lastUsedAt: number;
}

function normalizeTimestamp(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizePageType(value: unknown): string {
  return String(value || '').trim() || 'default';
}

/** 清洗并排序最近目录列表 */
export function normalizeRecentTargetDirectories(value: unknown): RecentDirectoryEntry[] {
  if (!Array.isArray(value)) return [];

  const sorted = value
    .map((item: unknown) => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const path = normalizePath(obj.path);
      if (!path) return null;
      return {
        path,
        pageType: normalizePageType(obj.pageType),
        lastUsedAt: normalizeTimestamp(obj.lastUsedAt),
      };
    })
    .filter((e): e is RecentDirectoryEntry => e !== null)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  // 按 path 去重，保留时间戳最新的
  const seen = new Set<string>();
  const deduped: RecentDirectoryEntry[] = [];
  for (const record of sorted) {
    if (seen.has(record.path)) continue;
    seen.add(record.path);
    deduped.push(record);
  }
  return deduped;
}

/** 合并一条新目录记录 */
export function mergeRecentTargetDirectories(
  records: unknown,
  nextRecord: Partial<RecentDirectoryEntry> & { path?: string },
): RecentDirectoryEntry[] {
  const normalizedPath = normalizePath(nextRecord.path);
  if (!normalizedPath) return normalizeRecentTargetDirectories(records);

  const merged = [
    {
      path: normalizedPath,
      pageType: normalizePageType(nextRecord.pageType),
      lastUsedAt: normalizeTimestamp(nextRecord.lastUsedAt) || Date.now(),
    },
    ...normalizeRecentTargetDirectories(records),
  ];
  return normalizeRecentTargetDirectories(merged);
}

async function loadRecords(): Promise<RecentDirectoryEntry[]> {
  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.RECENT_DIRECTORIES]: [] });
  return normalizeRecentTargetDirectories(stored[STORAGE_KEYS.RECENT_DIRECTORIES]);
}

async function saveRecords(records: RecentDirectoryEntry[]): Promise<RecentDirectoryEntry[]> {
  const normalized = normalizeRecentTargetDirectories(records);
  await chrome.storage.local.set({ [STORAGE_KEYS.RECENT_DIRECTORIES]: normalized });
  return normalized;
}

/** 查询最近使用目录列表 */
export async function getRecentTargetDirectories(): Promise<RecentDirectoryEntry[]> {
  return loadRecords();
}

/** 添加一条最近使用目录 */
export async function addRecentTargetDirectory(
  path: string,
  pageType?: string,
): Promise<RecentDirectoryEntry[]> {
  const records = await loadRecords();
  const next = mergeRecentTargetDirectories(records, { path, pageType, lastUsedAt: Date.now() });
  return saveRecords(next);
}

/** 删除一条最近使用目录 */
export async function removeRecentTargetDirectory(path: string): Promise<RecentDirectoryEntry[]> {
  const normalized = normalizePath(path);
  if (!normalized) return loadRecords();

  const records = await loadRecords();
  const next = records.filter((r) => r.path !== normalized);
  return saveRecords(next);
}

/** 一键清空所有历史目录记录 */
export async function clearAllRecentTargetDirectories(): Promise<RecentDirectoryEntry[]> {
  await saveRecords([]);
  return [];
}
