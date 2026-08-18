/**
 * 目录选择与历史相关类型。
 *
 * handle：浏览器 File System Access API 句柄，存 IndexedDB，跨会话需重新授权。
 */

import type { PageType } from './platform.js';

export interface HandleSelection {
  readonly kind: 'handle';
  readonly handle: FileSystemDirectoryHandle;
  /** 展示用标签（目录名） */
  readonly label?: string;
}

/** 最近使用目录条目 */
export interface RecentDirectoryEntry {
  readonly path: string;
  readonly pageType?: PageType;
  readonly lastUsedAt: number;
}

/** 文件读写的最小条目 */
export interface FilePayload {
  readonly path: string;
  readonly content: string;
}

export interface FileReadResult {
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
}

export interface FileStatResult {
  readonly fileName: string;
  readonly exists: boolean;
  readonly size: number | null;
  readonly modifiedAt: string;
}
