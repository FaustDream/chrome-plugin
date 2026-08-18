/**
 * 全局「上次选择目录」记录。
 *
 * 跨 pageType / tab 共享的单条目录记忆，用于解决「目录频繁恢复到默认」的问题：
 * - 新页面（含不同平台 / 页类型）自动回显上次成功选择的目录
 * - 当前 pageType 未绑定目录句柄时，回退到上次选择目录对应的句柄（跨页面读写兜底）
 *
 * 仅存目录名（File System Access API 出于安全不暴露完整绝对路径），
 * 完整读写能力通过 IndexedDB 中对应 pageType 的 FileSystemDirectoryHandle 获得。
 */

import { STORAGE_KEYS } from '../lib/constants.js';
import { normalizePath } from '../lib/utils.js';

// ── 类型 ──────────────────────────────────────────────

export interface LastDirectorySelection {
  readonly label: string;
  readonly pageType: string;
  readonly lastUsedAt: number;
}

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

// ── 公开 API ──────────────────────────────────────────

/** 读取全局上次选择目录记录（不存在返回 null） */
export async function getLastDirectorySelection(): Promise<LastDirectorySelection | null> {
  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.LAST_DIRECTORY]: null });
  return normalizeLastSelection(stored[STORAGE_KEYS.LAST_DIRECTORY]);
}

/** 保存全局上次选择目录记录（label 为空时返回 null 不写入） */
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
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_DIRECTORY]: record });
  return record;
}
