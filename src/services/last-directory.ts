/**
 * 全局「上次选择目录」记录（按平台分条）。
 *
 * 存储结构：`{ [STORAGE_KEYS.LAST_DIRECTORY]: { cloudpivot: {...}, h3yun: {...} } }`
 * 兼容旧结构：旧版直接存单条 `{ label, pageType, lastUsedAt }`，读取时自动迁移。
 *
 * 用途：
 * - 新页面（同平台不同页类型）自动回显该平台上次成功选择的目录
 * - 当前 pageType 未绑定目录句柄时，回退到该平台上次选择目录对应的句柄（跨页面读写兜底）
 *
 * 仅存目录名（File System Access API 出于安全不暴露完整绝对路径），
 * 完整读写能力通过 IndexedDB 中对应 pageType 的 FileSystemDirectoryHandle 获得。
 */

import { STORAGE_KEYS } from '../lib/constants.js';
import { normalizePath } from '../lib/utils.js';
import { getPlatformKeyFromPageType } from './config.js';
import type { PlatformKey } from '../types/platform.js';

// ── 类型 ──────────────────────────────────────────────

export interface LastDirectorySelection {
  readonly label: string;
  readonly pageType: string;
  readonly lastUsedAt: number;
}

/** 存储形状：按平台分条 */
type LastDirectorySelectionMap = Partial<Record<PlatformKey, LastDirectorySelection>>;

// ── 内部工具 ──────────────────────────────────────────

function normalizeTimestamp(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizePageType(value: unknown): string {
  return String(value || '').trim() || 'default';
}

function normalizeLastSelection(value: unknown): LastDirectorySelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const label = normalizePath(obj.label);
  if (!label) return null;
  return {
    label,
    pageType: normalizePageType(obj.pageType),
    lastUsedAt: normalizeTimestamp(obj.lastUsedAt),
  };
}

/** 判断存储值是否为「按平台分条」的新结构（顶层无 label 字段） */
function isPlatformMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && !('label' in (value as Record<string, unknown>));
}

// ── 公开 API ──────────────────────────────────────────

/**
 * 读取指定平台上次选择目录记录（不存在返回 null）。
 * pageType 省略时返回所有平台中时间最新的一条（兼容旧调用方）。
 */
export async function getLastDirectorySelection(pageType?: string): Promise<LastDirectorySelection | null> {
  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.LAST_DIRECTORY]: null });
  const value = stored[STORAGE_KEYS.LAST_DIRECTORY];
  const platformKey = pageType ? getPlatformKeyFromPageType(pageType) : undefined;

  if (isPlatformMap(value)) {
    const map = value as LastDirectorySelectionMap;
    if (platformKey) return normalizeLastSelection(map[platformKey]);
    let latest: LastDirectorySelection | null = null;
    for (const entry of Object.values(map)) {
      const normalized = normalizeLastSelection(entry);
      if (normalized && (!latest || normalized.lastUsedAt > latest.lastUsedAt)) latest = normalized;
    }
    return latest;
  }

  // 旧结构：单条（按平台过滤时校验归属，避免跨平台串用）
  const legacy = normalizeLastSelection(value);
  if (legacy && platformKey && getPlatformKeyFromPageType(legacy.pageType) !== platformKey) return null;
  return legacy;
}

/** 按平台保存上次选择目录记录（label 为空时返回 null 不写入） */
export async function saveLastDirectorySelection(
  label: string,
  pageType: string,
): Promise<LastDirectorySelection | null> {
  const normalizedLabel = normalizePath(label);
  if (!normalizedLabel) return null;

  const record: LastDirectorySelection = {
    label: normalizedLabel,
    pageType: normalizePageType(pageType),
    lastUsedAt: Date.now(),
  };
  const platformKey = getPlatformKeyFromPageType(record.pageType) as PlatformKey;

  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.LAST_DIRECTORY]: null });
  const prev = stored[STORAGE_KEYS.LAST_DIRECTORY];
  const base: LastDirectorySelectionMap = {};
  if (isPlatformMap(prev)) {
    Object.assign(base, prev as LastDirectorySelectionMap);
  } else {
    // 旧单条结构迁移到分条结构
    const legacy = normalizeLastSelection(prev);
    if (legacy) base[getPlatformKeyFromPageType(legacy.pageType) as PlatformKey] = legacy;
  }
  base[platformKey] = record;

  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_DIRECTORY]: base });
  return record;
}
