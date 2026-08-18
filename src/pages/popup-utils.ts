/**
 * popup 页纯工具函数 / 类型 / 常量。
 *
 * 模块边界：本文件只包含无 DOM / chrome.* / module 状态依赖的纯逻辑，
 * 便于复用与测试。事件绑定、状态与 DOM 操作留在 popup.ts。
 */
import type { RecentDirectoryEntry } from '../services/recent-target-directories.js';
import { resolveH3yunBackendFileName, resolveH3yunFrontendFileName } from '../lib/platform/h3yun-code.js';
import { parseModelCodesFromPageUrl } from '../lib/platform/readme-parser.js';
import { extractLastFolderName } from '../lib/utils.js';

/** 从页面 URL 解析应用编码/表单编码（统一转发 readme-parser 权威实现） */
export const extractModelCodesFromUrl = parseModelCodesFromPageUrl;

/** 从完整路径提取最后一段目录名（统一转发 utils 权威实现，避免双实现漂移） */
export { extractLastFolderName };

// ── 类型 ──────────────────────────────────────────────

/** 当前激活页面上下文（注入 executeScript 所需的最小 tab 信息） */
export interface PageContext {
  tabId?: number;
  url: string;
  title: string;
}

/** 状态区日志条目 */
export interface LogEntry {
  time: string;
  message: string;
  level: 'info' | 'success' | 'error' | 'warning';
  suggestion?: string;
  context?: Record<string, unknown>;
}

// ── 常量 ──────────────────────────────────────────────

/** 历史目录项点击后选中态保持时长（ms），随后执行跳转 */
export const SEARCH_ITEM_SELECT_ANIMATION_MS = 250;

/**
 * 氚云代码编辑器配置（与 gitHub 原版 H3YUN_CODE_EDITOR_CONFIG 一致）。
 * 注：氚云 Monaco 编辑器语言 ID 全为 undefined，TS 注入层已用内容特征正则替代 modeIds 匹配。
 */
export const H3YUN_CODE_EDITOR_CONFIG = {
  frontend: {
    codeKind: 'frontend' as const,
    label: '前端代码',
    selector: '#jsText',
  },
  backend: {
    codeKind: 'backend' as const,
    label: '后端代码',
    selector: '#csText',
  },
} as const;

// ── 纯工具函数 ────────────────────────────────────────

/** HTML 转义（注入日志、弹层标题等文本安全输出） */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, (ch) => map[ch] || ch);
}

/** 按查询过滤历史目录（大小写不敏感子串匹配） */
export function filterHistoryRecords(query: string, records: RecentDirectoryEntry[]): RecentDirectoryEntry[] {
  if (!query) return records;
  const q = query.toLowerCase();
  return records.filter((r) => r.path.toLowerCase().includes(q));
}

/** 解析云枢页面类型对应的组件名（gitHub 原版 resolveCloudpivotComponentName 等价） */
export function resolveCloudpivotComponentName(pageType: string): string {
  return pageType === 'list' ? 'ListEditor' : 'editor';
}

/** 格式化注入失败结果（InjectionFailure 诊断信息 → 可读文本） */
export function formatProbeFailure(result: unknown, fallback: string): string {
  if (!result) return fallback;
  const r = result as { ok?: boolean; errorCode?: string; details?: unknown };
  if (r.ok === false) {
    const detail = Array.isArray(r.details) ? r.details.join('；') : String(r.details || '');
    return `${r.errorCode || 'ERROR'}${detail ? `：${detail}` : ''}`;
  }
  return fallback;
}

/** 压缩多余空行，避免回写时引入噪音（与 gitHub normalizeExcessBlankLines 一致） */
export function normalizeExcessBlankLines(content: string): string {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n(?:[ \t]*\n){2,}/g, '\n\n');
}

/** 解析氚云回写时应读取的本地文件名（前端按设计模式，后端按内容特征） */
export function resolveH3yunCodeFileName(
  codeKind: 'frontend' | 'backend',
  result: { sourceContent?: string; pageUrl?: string },
  pageUrl: string,
  designMode: 'form' | 'list' | 'unknown',
): string {
  return codeKind === 'backend'
    ? resolveH3yunBackendFileName({ sourceContent: result?.sourceContent, pageUrl })
    : resolveH3yunFrontendFileName({ pageUrl, designMode });
}

/** 生成导出文件的下载时间戳（ISO 去分隔符，例：2026-08-04-10-30-00） */
export function buildDownloadTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
}
