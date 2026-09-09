/**
 * 目标目录透明读写层（纯浏览器模式）。
 *
 * 使用 File System Access API（showDirectoryPicker + FileSystemDirectoryHandle）
 * 实现本地目录的读写，无需安装任何 Native Host。
 *
 * 目录选择、文件读写均在 popup/options 页面发起。
 */

import { logger } from '../lib/logger.js';
import { DirectoryError, ValidationError, ERROR_CODE } from '../lib/errors.js';
import {
  saveTargetDirectoryHandleForScope,
  getTargetDirectoryHandleForScope,
  getDefaultDirectoryHandle,
} from '../lib/directory/file-handle-db.js';
import { createTargetDirectoryPageScope } from './target-directory-session.js';
import { getPlatformKeyFromPageType } from './config.js';
import {
  getStoredDirectoryPath,
  saveHandleSelection,
  clearTabTargetDirectoryData,
  resolveTargetDirectoryHandle,
} from './target-directory-state.js';

// ── 公开类型 ──────────────────────────────────────────

export interface FileWriteEntry {
  readonly fileName: string;
  readonly content: string;
}

export interface FileReadEntry {
  readonly fileName: string;
  readonly content: string;
  readonly exists: boolean;
}

export interface FileStatEntry {
  readonly fileName: string;
  readonly exists: boolean;
  readonly size: number | null;
  readonly modifiedAt: string;
}

export interface ReadFilesResult {
  readonly files: readonly FileReadEntry[];
}

export interface StatFilesResult {
  readonly files: readonly FileStatEntry[];
}

export interface SelectDirectoryResult {
  readonly path: string;
  readonly source: 'handle';
  readonly label: string;
}

export interface WriteFilesResult {
  readonly written: number;
  /** 目录标签（Handle 通道为目录名） */
  readonly directoryPath?: string;
}

// ── 内部工具 ──────────────────────────────────────────

function normalizeFileName(value: unknown): string {
  return String(value || '').replace(/[/\\:*?"<>|]/g, '_').trim();
}

interface TabInfo {
  readonly id?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
}

// Chrome Extension 环境中的 FileSystemDirectoryHandle 扩展
type ExtendedDirectoryHandle = FileSystemDirectoryHandle & {
  requestPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  queryPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

interface DirectoryPickerOptions {
  /** 目录选择器初始打开位置（当前环境已绑定目录的句柄） */
  readonly startIn?: FileSystemDirectoryHandle;
}

function showDirPicker(options: DirectoryPickerOptions = {}): Promise<FileSystemDirectoryHandle> {
  const w = window as unknown as {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
      startIn?: FileSystemDirectoryHandle;
    }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== 'function') {
    throw new ValidationError('showDirectoryPicker not available', { available: false });
  }

  // 选择时直接请求读写权限：授权状态由浏览器缓存，后续操作从缓存获取，避免首次回写失败
  const build = (startIn?: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> =>
    w.showDirectoryPicker!({
      mode: 'readwrite',
      ...(startIn ? { startIn } : {}),
    });

  if (!options.startIn) return build();

  // 指定 startIn（当前环境已绑定目录）时，若句柄因权限被撤销等原因失效会抛错，
  // 此时回退为不带 startIn 重试，保证目录选择器仍可正常打开。
  return build(options.startIn).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    logger.warn('showDirectoryPicker with startIn failed, retrying without startIn', { error: String(error) });
    return build();
  });
}

function requestHandlePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite',
): Promise<PermissionState> {
  const ext = handle as unknown as ExtendedDirectoryHandle;
  if (typeof ext.requestPermission === 'function') {
    return ext.requestPermission({ mode });
  }
  return Promise.resolve('granted');
}

/** 查询句柄当前权限（不触发授权弹窗） */
function queryHandlePermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const ext = handle as unknown as ExtendedDirectoryHandle;
  if (typeof ext.queryPermission === 'function') {
    return ext.queryPermission({ mode: 'readwrite' });
  }
  return Promise.resolve('granted');
}

// ── 目录选择器可用性 ──────────────────────────────────

export function supportsDirectoryPicker(): boolean {
  try {
    return typeof window !== 'undefined'
      && 'showDirectoryPicker' in (window as unknown as Record<string, unknown>)
      && typeof (window as unknown as Record<string, unknown>).showDirectoryPicker === 'function';
  } catch {
    return false;
  }
}

// ── 目录选择 ──────────────────────────────────────────

/**
 * 解析目录选择器初始打开位置（startIn）对应的句柄。
 *
 * 优先级（由高到低）：
 *  1) 当前页面 scope 句柄（该页面已绑定目录，选择器定位到当前目录）
 *  2) 当前项目（平台）设置的默认目录句柄（新页面手动选择时的快捷定位）
 *  3) 无（回退为系统默认，即不带 startIn）
 *
 * 明确排除旧共享槽：不经过 resolveTargetDirectoryHandle（scope 之外还有
 * 平台「上次选择目录」回退），也不读取 pageType 全局句柄，避免选择器
 * 打开到其他页面 / 其他项目的历史目录。
 */
async function resolveDirectoryPickerStartIn(
  tab: TabInfo | number,
  pageType: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  const granted = async (handle?: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | undefined> =>
    handle && (await queryHandlePermission(handle)) === 'granted' ? handle : undefined;

  // 1) 当前页面 scope 句柄（该页面已绑定目录）
  const pageScope = createTargetDirectoryPageScope(tab, pageType);
  if (pageScope) {
    const scopeHandle = await granted(await getTargetDirectoryHandleForScope(pageScope));
    if (scopeHandle) return scopeHandle;
  }

  // 2) 当前项目（平台）设置的默认目录句柄（新页面手动选择时的快捷定位）
  const platformKey = getPlatformKeyFromPageType(pageType);
  const defaultHandle = await granted(await getDefaultDirectoryHandle(platformKey));
  if (defaultHandle) return defaultHandle;

  return undefined;
}

/** 弹出原生目录选择器并保存绑定 */
export async function selectHandleDirectory(
  tab: TabInfo | number,
  pageType = 'default',
): Promise<SelectDirectoryResult | null> {
  if (!supportsDirectoryPicker()) return null;

  try {
    // 「更新当前路径」默认打开「当前有效路径 → 项目默认目录」对应的句柄（startIn），
    // 禁止回退到系统全局默认目录 / 上一次缓存目录 / 其他项目历史目录。
    const startIn = await resolveDirectoryPickerStartIn(tab, pageType);

    const handle = await showDirPicker(startIn ? { startIn } : {});
    // 选择后立即确认读写权限已授予（showDirectoryPicker({ mode: 'readwrite' }) 会弹浏览器自带授权，
    // 授权状态写入浏览器缓存，后续 queryPermission/requestPermission 直接复用缓存）
    const permission = await requestHandlePermission(handle, 'readwrite');
    if (permission !== 'granted') {
      logger.warn('Directory readwrite permission not granted', { pageType, permission });
      return null;
    }
    await saveHandleSelection(handle, tab, pageType);
    return { path: '', source: 'handle', label: handle.name || '' };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    logger.error('Handle directory selection failed', { error: String(error) });
    return null;
  }
}

/** 选择目录并保存绑定 */
export async function selectAndBindDirectory(
  tab: TabInfo | number,
  options: {
    pageType?: string;
    isPageSnapshot?: boolean;
  } = {},
): Promise<SelectDirectoryResult | null> {
  const pageType = String(options.pageType || 'default');
  const isPageSnapshot = options.isPageSnapshot ?? false;

  if (!supportsDirectoryPicker()) {
    throw new ValidationError('当前浏览器不支持 File System Access API', {
      hint: '请使用 Chrome 86+ 或 Edge 86+ 版本',
    });
  }

  return await selectHandleDirectory(tab, pageType);
}

// ── 文件读写（仅 Handle 通道） ─────────────────────────

/** 通过 Handle 通道写文件 */
async function writeFilesViaHandle(
  handle: ExtendedDirectoryHandle,
  fileEntries: readonly FileWriteEntry[],
): Promise<WriteFilesResult> {
  const permission = await requestHandlePermission(handle, 'readwrite');
  if (permission !== 'granted') {
    throw new DirectoryError(ERROR_CODE.DIRECTORY_PERMISSION_DENIED, '目录写入权限未授予，请点击「更新当前路径」重新授权后重试。');
  }

  let written = 0;
  for (const entry of fileEntries) {
    const fileName = normalizeFileName(entry.fileName);
    if (!fileName) continue;

    try {
      const fileHandle = await handle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(entry.content);
      await writable.close();
      written++;
    } catch (error: unknown) {
      logger.warn('Handle write file failed', { fileName, error: String(error) });
    }
  }

  return { written, directoryPath: handle.name };
}

/** 通过 Handle 通道读取文件 */
async function readFilesViaHandle(
  handle: ExtendedDirectoryHandle,
  fileNames: readonly string[],
): Promise<FileReadEntry[]> {
  const entries: FileReadEntry[] = [];

  for (const fileName of fileNames) {
    const name = normalizeFileName(fileName);
    if (!name) {
      entries.push({ fileName: fileName || '', content: '', exists: false });
      continue;
    }

    try {
      const fileHandle = await handle.getFileHandle(name);
      const file = await fileHandle.getFile();
      const content = await file.text();
      entries.push({ fileName: name, content, exists: true });
    } catch {
      entries.push({ fileName: name, content: '', exists: false });
    }
  }

  return entries;
}

/** 通过 Handle 通道检查文件存在性 */
async function statFilesViaHandle(
  handle: ExtendedDirectoryHandle,
  fileNames: readonly string[],
): Promise<FileStatEntry[]> {
  const entries: FileStatEntry[] = [];

  for (const fileName of fileNames) {
    const name = normalizeFileName(fileName);
    if (!name) {
      entries.push({ fileName: fileName || '', exists: false, size: null, modifiedAt: '' });
      continue;
    }

    try {
      const fileHandle = await handle.getFileHandle(name);
      const file = await fileHandle.getFile();
      entries.push({
        fileName: name,
        exists: true,
        size: file.size,
        modifiedAt: new Date(file.lastModified).toISOString(),
      });
    } catch {
      entries.push({ fileName: name, exists: false, size: null, modifiedAt: '' });
    }
  }

  return entries;
}

/** 写文件到当前绑定目录 */
export async function writeFilesToSelection(
  tab: TabInfo | number,
  pageType: string,
  fileEntries: readonly FileWriteEntry[],
): Promise<WriteFilesResult> {
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
    return { written: 0 };
  }

  const handle = await resolveTargetDirectoryHandle(tab, pageType) as ExtendedDirectoryHandle | undefined;
  if (!handle) {
    throw new DirectoryError(ERROR_CODE.DIRECTORY_NOT_SELECTED, '请先选择目标目录。');
  }

  const pageScope = createTargetDirectoryPageScope(tab, pageType);
  await saveTargetDirectoryHandleForScope(handle, pageScope);
  return await writeFilesViaHandle(handle, fileEntries);
}

/** 从当前绑定目录读取文件列表 */
export async function readFilesFromSelection(
  tab: TabInfo | number,
  pageType: string,
  fileNames: readonly string[],
): Promise<ReadFilesResult> {
  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    return { files: [] };
  }

  const handle = await resolveTargetDirectoryHandle(tab, pageType) as ExtendedDirectoryHandle | undefined;
  if (!handle) {
    throw new DirectoryError(ERROR_CODE.DIRECTORY_NOT_SELECTED, '请先选择目标目录。');
  }

  const permission = await requestHandlePermission(handle, 'read');
  if (permission !== 'granted') {
    throw new DirectoryError(ERROR_CODE.DIRECTORY_PERMISSION_DENIED, '目录读取权限未授予，请点击「更新当前路径」重新授权后重试。');
  }
  const files = await readFilesViaHandle(handle, fileNames);
  return { files };
}

/** 检查目标目录中文件是否存在 */
export async function fileExistsInSelection(
  tab: TabInfo | number,
  pageType: string,
  fileNames: readonly string[],
): Promise<StatFilesResult> {
  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    return { files: [] };
  }

  const handle = await resolveTargetDirectoryHandle(tab, pageType) as ExtendedDirectoryHandle | undefined;
  if (!handle) {
    throw new DirectoryError(ERROR_CODE.DIRECTORY_NOT_SELECTED, '请先选择目标目录。');
  }

  const permission = await requestHandlePermission(handle, 'read');
  if (permission !== 'granted') {
    throw new DirectoryError(ERROR_CODE.DIRECTORY_PERMISSION_DENIED, '目录读取权限未授予，请点击「更新当前路径」重新授权后重试。');
  }
  const files = await statFilesViaHandle(handle, fileNames);
  return { files };
}

// ── 句柄权限状态（重启后重新授权） ────────────────────

/** 目录句柄权限状态：none 表示未绑定句柄 */
export type DirectoryPermissionState = 'granted' | 'denied' | 'prompt' | 'none';

function normalizePermissionState(state: PermissionState): DirectoryPermissionState {
  return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt';
}

/** 查询当前有效句柄的权限状态（不触发授权弹窗） */
export async function getTargetDirectoryPermission(
  tab: TabInfo | number,
  pageType: string,
): Promise<DirectoryPermissionState> {
  const handle = await resolveTargetDirectoryHandle(tab, pageType);
  if (!handle) return 'none';
  return normalizePermissionState(await queryHandlePermission(handle));
}

/** 主动请求当前句柄授权（会触发浏览器授权弹窗，需在用户手势中调用） */
export async function requestTargetDirectoryPermission(
  tab: TabInfo | number,
  pageType: string,
): Promise<DirectoryPermissionState> {
  const handle = await resolveTargetDirectoryHandle(tab, pageType);
  if (!handle) return 'none';
  return normalizePermissionState(await requestHandlePermission(handle, 'readwrite'));
}

// ── 指定句柄权限（历史路径恢复专用） ──────────────────

/**
 * 查询指定句柄的权限状态（不触发授权弹窗）。
 * 用于历史路径恢复：直接检查历史句柄自身权限，
 * 而非通过 resolveTargetDirectoryHandle 的 scope 解析（后者可能命中当前页面的其他句柄）。
 */
export async function queryHandlePermissionState(
  handle: FileSystemDirectoryHandle,
): Promise<DirectoryPermissionState> {
  return normalizePermissionState(await queryHandlePermission(handle));
}

/**
 * 请求指定句柄的读写授权（会触发浏览器授权弹窗，需在用户手势中调用）。
 * 用于历史路径恢复：直接对历史句柄请求授权。
 */
export async function requestHandlePermissionState(
  handle: FileSystemDirectoryHandle,
): Promise<DirectoryPermissionState> {
  return normalizePermissionState(await requestHandlePermission(handle, 'readwrite'));
}

// 重新导出
export {
  getStoredDirectoryPath,
  saveHandleSelection,
  clearTabTargetDirectoryData,
};