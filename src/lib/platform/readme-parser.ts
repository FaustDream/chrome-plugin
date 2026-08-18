/**
 * README / FromCode 解析与生成模块。
 *
 * 负责：
 * - 从云枢页面 HTML 中提取表单元数据（控件列表、子表、链接等）
 * - 生成 FromCode.md（编码上下文）
 * - 关联表单信息回收（跨多次抓取保留人工填写的关联信息）
 */

import { cleanInlineText } from '../utils.js';
import {
  formatControlTypeLabel,
  supportsAssociationMetadata,
  supportsCustomOptions,
  supportsDateFormat,
} from './control-metadata.js';

// ── 类型 ──────────────────────────────────────────────

export interface LinkInfo {
  readonly href: string;
  readonly linkText: string;
  readonly applicationCode: string;
  readonly applicationName: string;
  readonly formCode: string;
  readonly formName: string;
}

export interface ControlInfo {
  readonly code: string;
  readonly name: string;
  readonly scopeKey: string;
  readonly tagName: string;
  readonly typeLabel: string;
  readonly options: readonly string[];
  readonly dateFormat: string;
  readonly relationFormCode: string;
  readonly relationFormName: string;
}

export interface SubtableInfo {
  readonly code: string;
  readonly name: string;
  readonly controls: readonly ControlInfo[];
}

export interface ReadmeMetadata {
  readonly applicationCode: string;
  readonly applicationName: string;
  readonly formCode: string;
  readonly formName: string;
  readonly mainTableCode: string;
  readonly links: readonly LinkInfo[];
  readonly mainControls: readonly ControlInfo[];
  readonly subtables: readonly SubtableInfo[];
}

// ── 内部工具 ──────────────────────────────────────────

function stripHtmlTags(value: string): string {
  return cleanInlineText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function getAttributeValue(source: string, attributeName: string): string {
  const pattern = new RegExp(`(?:^|\\s)${attributeName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = String(source || '').match(pattern);
  return cleanInlineText(match?.[2] ?? '');
}

/** 解码 data-options 属性值中常见的 HTML 实体（属性值转义） */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeOptionLabel(option: unknown): string {
  if (typeof option === 'string' || typeof option === 'number') return cleanInlineText(String(option));
  if (!option || typeof option !== 'object') return '';
  const o = option as Record<string, unknown>;
  const i18n = (typeof o.name_i18n === 'object' && o.name_i18n) ? o.name_i18n as Record<string, unknown> : null;
  const fallback = String(o.value ?? o.label ?? o.name ?? o.text ?? o.code ?? '');
  return cleanInlineText(String(i18n?.zh ?? fallback));
}

/** 从任意选项数组结构中提取去重后的选项标签 */
function collectOptionLabels(rawOptions: unknown): readonly string[] {
  let items: unknown[] = [];
  if (Array.isArray(rawOptions)) {
    items = rawOptions;
  } else if (rawOptions && typeof rawOptions === 'object') {
    const obj = rawOptions as Record<string, unknown>;
    if (Array.isArray(obj.custom)) items = obj.custom;
    else if (Array.isArray(obj.options)) items = obj.options;
    else if (Array.isArray(obj.items)) items = obj.items;
  }

  const seen = new Set<string>();
  const options: string[] = [];
  for (const option of items) {
    const label = normalizeOptionLabel(option);
    if (label && !seen.has(label)) {
      seen.add(label);
      options.push(label);
    }
  }
  return options;
}

function extractControlOptions(tagName: string, attrs: string): readonly string[] {
  if (!supportsCustomOptions(tagName)) return [];

  const rawOptions = getAttributeValue(attrs, 'data-options');
  if (!rawOptions) return [];

  try {
    const parsed = JSON.parse(decodeHtmlEntities(rawOptions)) as unknown;
    // 对象结构：仅 optionsType === 'custom' 时才提取（数据联动等非自定义选项不参与）
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.optionsType && obj.optionsType !== 'custom') return [];
      return collectOptionLabels(obj);
    }
    // 数组结构：直接提取
    return collectOptionLabels(parsed);
  } catch {
    return [];
  }
}

/** 提取日期控件的日期格式（data-format1） */
function extractDateFormat(tagName: string, attrs: string): string {
  if (!supportsDateFormat(tagName)) return '';
  return getAttributeValue(attrs, 'data-format1');
}

function extractAssociationMetadata(tagName: string, attrs: string) {
  if (!supportsAssociationMetadata(tagName)) return { relationFormCode: '', relationFormName: '' };
  return {
    relationFormCode: cleanInlineText(
      getAttributeValue(attrs, 'data-schema-code') || getAttributeValue(attrs, 'data-query-code'),
    ),
    relationFormName: '',
  };
}

const SCOPE_MAIN = 'main';
function buildMainControlScopeKey(): string { return SCOPE_MAIN; }
function buildSubtableControlScopeKey(subtableCode: string): string {
  return `subtable:${cleanInlineText(subtableCode)}`;
}
function buildAssociationValueKey(scopeKey: string, controlCode: string): string {
  return `${cleanInlineText(scopeKey) || SCOPE_MAIN}|${cleanInlineText(controlCode)}`;
}

// ── 解析 ──────────────────────────────────────────────

/**
 * 从页面 URL 解析应用编码和表单编码（model 参数统一解析的权威实现）。
 *
 * 优先级：URL 的 searchParams.model 参数 → 全 URL token 扫描。
 * 与 cloudpivot-capture.ts 注入版 extractModelCodes 保持行为一致（注入版因 executeScript 序列化约束无法 import 本模块）。
 */
export function parseModelCodesFromPageUrl(pageUrl: string): { applicationCode: string; formCode: string } {
  const fallback = { applicationCode: '', formCode: '' };
  const normalized = String(pageUrl || '');
  if (!normalized) return fallback;

  // 非法 percent 序列会抛 URIError，解析失败时按原始字符串继续
  let decoded = normalized;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    // 保持原始字符串参与后续拆分
  }

  // 优先取 searchParams.model（形如 model=应用编码/表单编码）
  try {
    const url = new URL(decoded);
    const modelParam = url.searchParams.get('model');
    if (modelParam) {
      const parts = modelParam.split(/[/?#&=]/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        return { applicationCode: parts[0] ?? '', formCode: parts[1] ?? '' };
      }
    }
  } catch {
    // 非合法 URL，继续 token 扫描
  }

  // 全 URL token 扫描兜底
  const parts = decoded.split(/[/?#&=]/).map((p) => p.trim()).filter(Boolean);
  const modelIndex = parts.findIndex((p) => p.toLowerCase() === 'model');
  if (modelIndex >= 0) {
    return {
      applicationCode: parts[modelIndex + 1] || '',
      formCode: parts[modelIndex + 2] || '',
    };
  }

  return fallback;
}

function extractLinksFromHtml(htmlSource: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  const seen = new Set<string>();
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = linkPattern.exec(htmlSource);
  while (match) {
    const href = cleanInlineText(match[1] ?? '');
    if (href && !seen.has(href)) {
      seen.add(href);
      links.push({
        href,
        linkText: stripHtmlTags(match[2] ?? ''),
        applicationCode: '',
        applicationName: '',
        formCode: '',
        formName: '',
      });
    }
    match = linkPattern.exec(htmlSource);
  }
  return links;
}

function extractControlsFromBlock(blockHtml: string, scopeKey: string): ControlInfo[] {
  const controls: ControlInfo[] = [];
  const seen = new Set<string>();
  const controlPattern = /<([a-z0-9-]+)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi;
  let match = controlPattern.exec(blockHtml);
  while (match) {
    const tagName = String(match[1] || '').toLowerCase();
    // 跳过标题/子表/按钮标记元素
    if (tagName === 'a-title' || tagName === 'a-sheet' || tagName === 'a-sheet-action') {
      match = controlPattern.exec(blockHtml);
      continue;
    }

    const attrs = match[2] || '';
    const code = getAttributeValue(attrs, 'key');
    const name = getAttributeValue(attrs, 'data-name');
    if (code && name) {
      const uniqueKey = `${code}|${name}`;
      if (!seen.has(uniqueKey)) {
        seen.add(uniqueKey);
        controls.push({
          code,
          name,
          scopeKey,
          tagName,
          typeLabel: formatControlTypeLabel(tagName),
          options: extractControlOptions(tagName, attrs),
          dateFormat: extractDateFormat(tagName, attrs),
          ...extractAssociationMetadata(tagName, attrs),
        });
      }
    }
    match = controlPattern.exec(blockHtml);
  }
  return controls;
}

/** 从页面 HTML 源码提取完整的表单元数据 */
export function extractReadmeMetadataFromHtml(htmlSource: string, pageUrl: string): ReadmeMetadata {
  const html = String(htmlSource || '');
  const modelCodes = parseModelCodesFromPageUrl(pageUrl);
  const links = extractLinksFromHtml(html);

  const titleMatch = html.match(/<a-title\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a-title>/i);
  const formName = cleanInlineText(
    getAttributeValue(titleMatch?.[1] || '', 'data-name') || stripHtmlTags(titleMatch?.[2] || ''),
  );

  const subtables: SubtableInfo[] = [];
  const subtablePattern = /<a-sheet\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a-sheet>/gi;
  let subMatch = subtablePattern.exec(html);
  while (subMatch) {
    const attrs = subMatch[1] || '';
    const body = subMatch[2] || '';
    const code = getAttributeValue(attrs, 'key');
    const name = getAttributeValue(attrs, 'data-name') || code || '';
    if (code) {
      subtables.push({ code, name, controls: extractControlsFromBlock(body, buildSubtableControlScopeKey(code)) });
    }
    subMatch = subtablePattern.exec(html);
  }

  const htmlWithoutSubtables = html.replace(subtablePattern, ' ');
  const mainControls = extractControlsFromBlock(htmlWithoutSubtables, buildMainControlScopeKey());

  return {
    applicationCode: modelCodes.applicationCode,
    applicationName: '',
    formCode: modelCodes.formCode,
    formName,
    mainTableCode: modelCodes.formCode,
    links,
    mainControls,
    subtables,
  };
}

// ── 文档字段标签 / 段名常量（生成与回收解析共用，保证字段契约一致） ──

const PLATFORM_LABEL_CLOUDPIVOT = '云枢';
const DATA_SOURCE_HTML = 'html';
const SECTION_MAIN_CONTROLS = '主表控件';
const SECTION_SUBTABLES = '子表信息';
const LABEL_PLATFORM = '平台';
const LABEL_APP_CODE = '应用编码';
const LABEL_FORM_CODE = '表单编码';
const LABEL_FORM_NAME = '表单名称';
const LABEL_DATA_SOURCE = '数据来源';
const LABEL_PAGE_URL = '页面地址';
const LABEL_SUBTABLE_NAME = '子表名称';
const LABEL_SUBTABLE_CODE = '子表编码';
const LABEL_CONTROL_PREFIX = '控件';
const LABEL_SUBTABLE_CONTROL_PREFIX = '子表控件';
const LABEL_OPTIONS = '选项值';
const LABEL_DATE_FORMAT = '日期格式';
const LABEL_RELATION_FORM_CODE = '关联表单编码';
const LABEL_RELATION_FORM_NAME = '关联表单名称';

// ── 关联表单信息回收（跨多次抓取保留） ────────────────

type AssociationValues = Map<string, { relationFormCode: string; relationFormName: string }>;

function extractExistingAssociationValues(existingFromCodeContent: string): AssociationValues {
  const result: AssociationValues = new Map();
  let currentScopeKey = buildMainControlScopeKey();
  let currentControlCode = '';

  for (const rawLine of String(existingFromCodeContent || '').split(/\r?\n/)) {
    const line = String(rawLine || '');
    if (line === SECTION_MAIN_CONTROLS) { currentScopeKey = buildMainControlScopeKey(); currentControlCode = ''; continue; }
    if (line === SECTION_SUBTABLES) { currentScopeKey = ''; currentControlCode = ''; continue; }
    if (line.startsWith(`${LABEL_SUBTABLE_CODE}: `)) { currentScopeKey = buildSubtableControlScopeKey(line.slice(`${LABEL_SUBTABLE_CODE}: `.length)); currentControlCode = ''; continue; }
    if (line.startsWith(`${LABEL_CONTROL_PREFIX}编码: `) || line.startsWith(`${LABEL_SUBTABLE_CONTROL_PREFIX}编码: `)) {
      currentControlCode = cleanInlineText(line.slice(line.indexOf(': ') + 2));
      continue;
    }
    if (!currentControlCode) continue;

    if (line.startsWith(`${LABEL_RELATION_FORM_CODE}: `)) {
      const relationFormCode = cleanInlineText(line.slice(`${LABEL_RELATION_FORM_CODE}: `.length));
      const key = buildAssociationValueKey(currentScopeKey, currentControlCode);
      const prev = result.get(key);
      result.set(key, { relationFormCode, relationFormName: prev?.relationFormName ?? '' });
      continue;
    }
    if (line.startsWith(`${LABEL_RELATION_FORM_NAME}: `)) {
      const relationFormName = cleanInlineText(line.slice(`${LABEL_RELATION_FORM_NAME}: `.length));
      const key = buildAssociationValueKey(currentScopeKey, currentControlCode);
      const prev = result.get(key);
      result.set(key, { relationFormCode: prev?.relationFormCode ?? '', relationFormName });
    }
  }

  return result;
}

function resolveAssociationValues(control: ControlInfo, existing: AssociationValues) {
  const existingValue = existing.get(buildAssociationValueKey(control.scopeKey, control.code)) ?? { relationFormCode: '', relationFormName: '' };
  return {
    relationFormCode: cleanInlineText(existingValue.relationFormCode) || cleanInlineText(control.relationFormCode),
    relationFormName: cleanInlineText(existingValue.relationFormName) || cleanInlineText(control.relationFormName),
  };
}

// ── 文档生成 ──────────────────────────────────────────

function appendControlLines(
  lines: string[],
  control: ControlInfo,
  labelPrefix: string,
  existingAssociationValues: AssociationValues,
): void {
  lines.push(`${labelPrefix}名称: ${cleanInlineText(control.name)}`);
  lines.push(`${labelPrefix}编码: ${control.code}`);
  lines.push(`${labelPrefix}类型: ${control.typeLabel}`);
  if (control.dateFormat) {
    lines.push(`${LABEL_DATE_FORMAT}: ${control.dateFormat}`);
  }
  if (control.options.length > 0) {
    lines.push(`${LABEL_OPTIONS}: ${control.options.join('、')}`);
  }
  if (supportsAssociationMetadata(control.tagName)) {
    const av = resolveAssociationValues(control, existingAssociationValues);
    lines.push(`${LABEL_RELATION_FORM_CODE}: ${av.relationFormCode}`);
    lines.push(`${LABEL_RELATION_FORM_NAME}: ${av.relationFormName}`);
  }
}

function appendControlSection(
  lines: string[],
  controls: readonly ControlInfo[],
  existing: AssociationValues,
): void {
  lines.push('', SECTION_MAIN_CONTROLS);
  if (controls.length === 0) { lines.push('无'); return; }
  for (const c of controls) appendControlLines(lines, c, LABEL_CONTROL_PREFIX, existing);
}

function appendSubtableSection(
  lines: string[],
  subtables: readonly SubtableInfo[],
  existing: AssociationValues,
): void {
  lines.push('', SECTION_SUBTABLES);
  if (subtables.length === 0) { lines.push('无'); return; }

  for (const t of subtables) {
    lines.push(`${LABEL_SUBTABLE_NAME}: ${cleanInlineText(t.name)}`);
    lines.push(`${LABEL_SUBTABLE_CODE}: ${t.code}`);
    if (t.controls.length === 0) { lines.push('无子表控件'); continue; }
    for (const c of t.controls) appendControlLines(lines, c, LABEL_SUBTABLE_CONTROL_PREFIX, existing);
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
}

function buildMetadataDocumentContent(
  metadata: ReadmeMetadata,
  pageUrl: string,
  existingFromCodeContent: string,
): string {
  const appCode = cleanInlineText(metadata.applicationCode);
  const formCode = cleanInlineText(metadata.formCode);
  const formName = cleanInlineText(metadata.formName);
  const existing = extractExistingAssociationValues(existingFromCodeContent);
  const lines: string[] = [];

  lines.push(`${LABEL_PAGE_URL}: ${pageUrl}`);
  lines.push(`${LABEL_PLATFORM}: ${PLATFORM_LABEL_CLOUDPIVOT}`);
  lines.push(`${LABEL_APP_CODE}: ${appCode}`);
  lines.push(`${LABEL_FORM_CODE}: ${formCode || metadata.mainTableCode || ''}`);
  lines.push(`${LABEL_FORM_NAME}: ${formName}`);
  lines.push(`${LABEL_DATA_SOURCE}: ${DATA_SOURCE_HTML}`);
  lines.push('');

  const mainControls = Array.isArray(metadata.mainControls) ? metadata.mainControls : [];
  const subtables = Array.isArray(metadata.subtables) ? metadata.subtables : [];

  appendControlSection(lines, mainControls, existing);
  appendSubtableSection(lines, subtables, existing);

  return `${lines.join('\n')}\n`;
}

/** 生成 FromCode.md 内容（含编码信息，不含需求说明） */
export function buildFromCodeContent(
  metadata: ReadmeMetadata,
  pageUrl: string,
  existingFromCodeContent = '',
): string {
  return buildMetadataDocumentContent(metadata, pageUrl, existingFromCodeContent);
}
