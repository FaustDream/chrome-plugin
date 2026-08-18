/**
 * 氚云代码匹配模块。
 *
 * 负责：C#/JS 源码内容识别、Monaco model 快照选择评分、
 * 类名/设计器 ID 提取、文件名推断、FromCode 内容生成。
 */

import { cleanInlineText } from '../utils.js';
import { H3YUN_CSHARP_PATTERN, H3YUN_FRONTEND_PATTERN } from '../constants.js';

// ── 常量 ──────────────────────────────────────────────

export const H3YUN_BACKEND_FALLBACK_FILE_NAME = 'h3yun-backend.cs';
export const H3YUN_FRONTEND_FALLBACK_FILE_NAME = 'h3yun-frontend.js';
const H3YUN_LIST_MODE_SUFFIX = '_ListViewController';

// ── 模型快照类型 ──────────────────────────────────────

export interface ModelSnapshot {
  readonly sourceContent?: string;
  readonly isContainerModel?: boolean;
  readonly isAttached?: boolean;
  readonly versionId?: number;
  readonly alternativeVersionId?: number;
  readonly index?: number;
  readonly length?: number;
}

// ── 内部工具 ──────────────────────────────────────────

function snapshotSource(snapshot: ModelSnapshot): string {
  return String(snapshot.sourceContent ?? '');
}

/** 将 ModelSnapshot 转换为适合比较评分的 Record */
function toScoreRecord(snapshot: ModelSnapshot): Record<string, number> {
  return {
    isContainerModel: snapshot.isContainerModel ? 1 : 0,
    isAttached: snapshot.isAttached ? 1 : 0,
    versionId: safeNumber(snapshot.versionId),
    alternativeVersionId: safeNumber(snapshot.alternativeVersionId),
    index: safeNumber(snapshot.index, -1),
    length: snapshotLength(snapshot),
  };
}

function snapshotLength(snapshot: ModelSnapshot): number {
  const explicit = Number(snapshot.length);
  return Number.isFinite(explicit) ? explicit : snapshotSource(snapshot).length;
}

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Monaco model 候选评分：
 * 多个 JS model 同时存在时，模板代码可能更长；
 * 优先选择挂载且版本更新的当前编辑 model。
 */
function compareModelSnapshots(left: Record<string, number>, right: Record<string, number>): number {
  const priorityKeys = ['isContainerModel', 'isAttached', 'versionId', 'alternativeVersionId', 'index', 'length'];
  for (const key of priorityKeys) {
    const l = safeNumber(left[key], key === 'index' ? -1 : 0);
    const r = safeNumber(right[key], key === 'index' ? -1 : 0);
    if (l !== r) return l - r;
  }
  return 0;
}

function sanitizeFileName(value: string): string {
  return cleanInlineText(value).replace(/[<>:"/\\|?*]/g, '');
}

function appendH3yunListModeSuffix(fileBaseName: string, designMode?: 'form' | 'list' | 'unknown'): string {
  // 列表设计模式下，前后端文件都统一挂同一个后缀，避免与常规模式的同名文件冲突。
  const normalizedBaseName = sanitizeFileName(fileBaseName);
  if (!normalizedBaseName || designMode !== 'list') return normalizedBaseName;
  if (normalizedBaseName.toLowerCase().endsWith(H3YUN_LIST_MODE_SUFFIX.toLowerCase())) return normalizedBaseName;
  return `${normalizedBaseName}${H3YUN_LIST_MODE_SUFFIX}`;
}

function stripH3yunSheetCodePrefix(value: string): string {
  const normalized = cleanInlineText(value);
  const match = normalized.match(/^[A-Za-z0-9]+\.([A-Za-z0-9_]+)$/);
  return match ? (match[1] ?? normalized) : normalized;
}

// ── 公开 API ──────────────────────────────────────────

/** 判断源码内容属于前端 JS 还是后端 C# */
export function isH3yunCodeKindMatch(sourceContent: string, codeKind: 'frontend' | 'backend'): boolean {
  const snippet = (sourceContent || '').substring(0, 2000);
  const isCSharp = H3YUN_CSHARP_PATTERN.test(snippet);
  if (codeKind === 'frontend') {
    return !isCSharp && H3YUN_FRONTEND_PATTERN.test(snippet);
  }
  return isCSharp;
}

/** 从多个 model 快照中选择最佳匹配 */
export function selectH3yunCodeModelSnapshot(
  snapshots: readonly ModelSnapshot[] = [],
  codeKind: 'frontend' | 'backend' = 'frontend',
): Record<string, number> | null {
  const candidates = snapshots
    .filter((s) => isH3yunCodeKindMatch(snapshotSource(s), codeKind))
    .map(toScoreRecord);

  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) => (compareModelSnapshots(best, cur) >= 0 ? best : cur));
}

/** 从 C# 源码提取类名 */
export function extractH3yunCSharpClassName(sourceContent: string): string {
  const match = String(sourceContent || '').match(/\b(?:public\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  return match?.[1] ? String(match[1]) : '';
}

/** 从页面 URL 提取设计器 ID */
export function extractH3yunDesignerId(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    const searchId = cleanInlineText(url.searchParams.get('id') ?? '');
    if (searchId) return searchId;

    const hashIndex = url.hash.indexOf('?');
    const hashQuery = hashIndex >= 0 ? url.hash.slice(hashIndex + 1) : '';
    return cleanInlineText(new URLSearchParams(hashQuery).get('id') ?? '');
  } catch (_error) {
    return '';
  }
}

/** 推断氚云后端 C# 文件名 */
export function resolveH3yunBackendFileName(input: {
  sourceContent?: string;
  pageUrl?: string;
  designMode?: 'form' | 'list' | 'unknown';
} = {}): string {
  const base = appendH3yunListModeSuffix(
    sanitizeFileName(extractH3yunCSharpClassName(input.sourceContent ?? ''))
    || sanitizeFileName(extractH3yunDesignerId(input.pageUrl ?? ''))
    || H3YUN_BACKEND_FALLBACK_FILE_NAME.replace(/\.cs$/i, ''),
    input.designMode,
  );
  return base.toLowerCase().endsWith('.cs') ? base : `${base}.cs`;
}

/** 推断氚云前端 JS 文件名 */
export function resolveH3yunFrontendFileName(input: {
  pageUrl?: string;
  designMode?: 'form' | 'list' | 'unknown';
} = {}): string {
  const base = appendH3yunListModeSuffix(
    sanitizeFileName(extractH3yunDesignerId(input.pageUrl ?? ''))
    || H3YUN_FRONTEND_FALLBACK_FILE_NAME.replace(/\.js$/i, ''),
    input.designMode,
  );
  return base.toLowerCase().endsWith('.js') ? base : `${base}.js`;
}

// ── 子表控件编码检查 ──────────────────────────────────

interface H3yunControlChild {
  readonly code?: string;
}

// ── FromCode 内容生成 ──────────────────────────────────

interface FromCodeControlMeta {
  readonly code?: string;
  readonly displayName?: string;
  readonly controlKey?: string;
  readonly sheetCode?: string;
  readonly defaultValue?: string;
  readonly boschemaCode?: string;
  readonly displayRule?: string;
  readonly defaultItems?: readonly { value?: string; name?: string; label?: string; text?: string }[];
  readonly children?: readonly FromCodeChildMeta[];
}

interface FromCodeChildMeta {
  readonly code?: string;
  readonly displayName?: string;
  readonly controlKey?: string;
  readonly defaultValue?: string;
  readonly boschemaCode?: string;
  readonly displayRule?: string;
  readonly defaultItems?: readonly { value?: string; name?: string; label?: string; text?: string }[];
}

function appendOptionalField(lines: string[], label: string, value: string | undefined): void {
  const v = cleanInlineText(value ?? '');
  if (v) lines.push(`${label}: ${v}`);
}

function appendOptionalItemsField(lines: string[], label: string, items: readonly { value?: string; name?: string; label?: string; text?: string }[] | undefined): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const values = items
    .map((item: { value?: string; name?: string; label?: string; text?: string }) => {
      if (item && typeof item === 'object') {
        return String(item.value || item.name || item.label || item.text || '');
      }
      return String(item || '');
    })
    .filter(Boolean);
  if (values.length > 0) lines.push(`${label}: ${values.join('、')}`);
}

export function buildH3yunFromCodeContent(metadata: {
  pageUrl?: string;
  appCode?: string;
  formId?: string;
  source?: string;
  controls?: readonly FromCodeControlMeta[];
} = {}): string {
  const controls = Array.isArray(metadata.controls) ? metadata.controls : [];
  const lines: string[] = [
    `页面地址: ${cleanInlineText(metadata.pageUrl ?? '')}`,
    '平台: 氚云',
    `应用编码: ${cleanInlineText(metadata.appCode ?? '')}`,
    `表单ID: ${cleanInlineText(metadata.formId ?? '')}`,
    `数据来源: ${cleanInlineText(metadata.source ?? '') || 'dom'}`,
    '',
    '主表控件',
  ];

  for (const c of controls) {
    lines.push(`控件名称: ${cleanInlineText(c.displayName ?? '')}`);
    lines.push(`控件编码: ${cleanInlineText(c.code ?? '')}`);
    lines.push(`控件类型: ${cleanInlineText(c.controlKey ?? '')}`);

    appendOptionalField(lines, '默认值', c.defaultValue);
    appendOptionalField(lines, '关联表单', c.boschemaCode);
    lines.push(`隐藏规则: ${cleanInlineText(c.displayRule ?? '')}`);
    appendOptionalItemsField(lines, '选项值', c.defaultItems);

    if (Array.isArray(c.children) && c.children.length > 0) {
      const sheetCode = cleanInlineText(c.sheetCode ?? '') || cleanInlineText(c.code ?? '');
      lines.push('', '子表信息');
      lines.push(`子表名称: ${cleanInlineText(c.displayName ?? '')}`);
      lines.push(`子表编码: ${sheetCode}`);
      appendOptionalField(lines, '关联表单', c.boschemaCode);

      for (const child of c.children) {
        lines.push(`子表控件名称: ${cleanInlineText(child.displayName ?? '')}`);
        lines.push(`子表控件编码: ${stripH3yunSheetCodePrefix(child.code ?? '')}`);
        lines.push(`子表控件类型: ${cleanInlineText(child.controlKey ?? '')}`);
        appendOptionalField(lines, '默认值', child.defaultValue);
        appendOptionalField(lines, '关联表单', child.boschemaCode);
        lines.push(`隐藏规则: ${cleanInlineText(child.displayRule ?? '')}`);
        appendOptionalItemsField(lines, '选项值', child.defaultItems);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
