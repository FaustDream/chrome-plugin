/**
 * FileSystemDirectoryHandle IndexedDB 持久化模块。
 *
 * 浏览器 FileSystemDirectoryHandle 不可直接存入 chrome.storage.local（结构化克隆会丢权限），
 * 故通过 IndexedDB 按 scope key 索引存储，提供跨会话的句柄恢复能力。
 *
 * 本模块引用 indexedDB（非 chrome.*），符合 lib/ 边界。
 */

import { FILE_HANDLE_DB_NAME, FILE_HANDLE_DB_VERSION, FILE_HANDLE_STORE_NAME } from '../constants.js';
import { ValidationError } from '../errors.js';

// ── 内部工具 ──────────────────────────────────────────

const HANDLE_KEY_PREFIX = 'target-directory';
const PAGE_HANDLE_KEY_PREFIX = 'target-directory-page';
const DEFAULT_HANDLE_KEY_PREFIX = 'target-directory-default';

function normalizeScopeKey(scopeKey: string): string {
  return String(scopeKey || '').trim();
}

function buildPageHandleKey(pageScope: string): string {
  const normalized = normalizeScopeKey(pageScope);
  if (!normalized) {
    throw new ValidationError('页面目录句柄 scope 不能为空。', { scopeKey: pageScope });
  }
  return `${PAGE_HANDLE_KEY_PREFIX}:${normalized}`;
}

function buildDefaultHandleKey(platformKey: string): string {
  const normalized = String(platformKey || '').trim();
  if (!normalized) {
    throw new ValidationError('默认目录 platformKey 不能为空。', { platformKey });
  }
  return `${DEFAULT_HANDLE_KEY_PREFIX}:${normalized}`;
}

// ── IndexedDB 底层 ────────────────────────────────────

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_HANDLE_DB_NAME, FILE_HANDLE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_HANDLE_STORE_NAME)) {
        db.createObjectStore(FILE_HANDLE_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_HANDLE_STORE_NAME, mode);
    const store = transaction.objectStore(FILE_HANDLE_STORE_NAME);

    let request: IDBRequest<T>;
    try {
      request = callback(store);
    } catch (error: unknown) {
      reject(error);
      database.close();
      return;
    }

    transaction.oncomplete = () => {
      database.close();
      resolve(request.result);
    };

    transaction.onerror = () => {
      reject(transaction.error || request.error || new Error('IndexedDB transaction failed.'));
      database.close();
    };
  });
}

// ── 公开 API ──────────────────────────────────────────

/** 保存平台默认目录句柄（对应设置页「默认目录」，按平台维度隔离） */
export async function saveDefaultDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  platformKey: string,
): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, buildDefaultHandleKey(platformKey)));
}

/** 读取平台默认目录句柄 */
export async function getDefaultDirectoryHandle(
  platformKey: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  return withStore('readonly', (store) => store.get(buildDefaultHandleKey(platformKey)));
}

/** 删除平台默认目录句柄 */
export async function clearDefaultDirectoryHandle(platformKey: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(buildDefaultHandleKey(platformKey)));
}

/** 保存页面级目录句柄快照 */
export async function saveTargetDirectoryHandleForScope(
  handle: FileSystemDirectoryHandle,
  pageScope: string,
): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, buildPageHandleKey(pageScope)));
}

/** 读取页面级目录句柄 */
export async function getTargetDirectoryHandleForScope(
  pageScope: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  const normalized = normalizeScopeKey(pageScope);
  if (!normalized) return undefined;
  return withStore('readonly', (store) => store.get(buildPageHandleKey(normalized)));
}

/** 清理页面级目录句柄 */
export async function clearTargetDirectoryHandleForScope(pageScope: string): Promise<void> {
  const normalized = normalizeScopeKey(pageScope);
  if (!normalized) return;
  await withStore('readwrite', (store) => store.delete(buildPageHandleKey(normalized)));
}

/** 标签页关闭后按 scope 前缀清理 IndexedDB 中的页面级句柄 */
export async function clearTargetDirectoryHandlesByScopePrefix(scopePrefix: string): Promise<void> {
  const normalized = normalizeScopeKey(scopePrefix);
  if (!normalized) return;

  const keyPrefix = `${PAGE_HANDLE_KEY_PREFIX}:${normalized}`;
  await withStore('readwrite', (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key || '').startsWith(keyPrefix)) {
        cursor.delete();
      }
      cursor.continue();
    };
    return request;
  });
}

/**
 * 清理全部「页类型全局句柄」（键前缀 target-directory:，不含 -page/-default）。
 * 旧版共享槽已整体退役：任何页面选择目录都会覆盖该槽，导致多页面路径互相污染。
 * 迁移清洗时调用，幂等。
 */
export async function clearAllTargetDirectoryHandles(): Promise<void> {
  const keyPrefix = `${HANDLE_KEY_PREFIX}:`;
  await withStore('readwrite', (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const key = String(cursor.key || '');
      if (key.startsWith(keyPrefix)) {
        cursor.delete();
      }
      cursor.continue();
    };
    return request;
  });
}
