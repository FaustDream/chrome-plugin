/**
 * 预检诊断服务。
 *
 * 每次抓取/回写前先跑预检，收集 blocker/warning/info 三级结果；
 * 存在未通过的 blocker 时操作中止，不碰目录、不碰编辑器。
 */
import { cleanInlineText, cleanMultilineText } from '../lib/utils.js';
import {
  PREFLIGHT_SEVERITY,
  PREFLIGHT_OPERATION_IDS,
  STORAGE_KEYS,
} from '../lib/constants.js';

// ── 类型 ──────────────────────────────────────────────

export type PreflightSeverity = 'blocker' | 'warning' | 'info';

export interface PreflightResult {
  readonly operationId: string;
  readonly checkId: string;
  readonly severity: PreflightSeverity;
  readonly ok: boolean;
  readonly errorCode: string;
  readonly evidence: string;
  readonly nextAction: string;
  readonly data: Record<string, unknown>;
}

export interface DirectorySnapshotEntry {
  readonly accessMode: string;
  readonly targetPath: string;
  readonly fileLimit: number;
  readonly truncated: boolean;
  readonly files: readonly FileSnapshot[];
}

export interface FileSnapshot {
  readonly fileName: string;
  readonly exists: boolean;
  readonly size: number | null;
  readonly modifiedAt: string;
}

export interface PageProbe {
  readonly url: string;
  readonly title: string;
  readonly platformKey: string;
  readonly pageType: string;
  readonly pageLabel: string;
  readonly monacoModels: readonly MonacoModelSnapshot[];
}

export interface MonacoModelSnapshot {
  readonly selector: string;
  readonly codeKind: string;
  readonly mounted: boolean;
  readonly modelCount: number | null;
  readonly editorCount: number | null;
  readonly selectedStrategy: string;
  readonly languageIds: readonly string[];
  readonly sourceLength: number | null;
  readonly errorCode: string;
  readonly diagnostic: string;
}

export interface DiagnosticPackage {
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly operationId: string;
  readonly extension: { readonly name: string; readonly version: string };
  readonly browser: { readonly userAgent: string };
  readonly logs: readonly unknown[];
  readonly pageProbe: PageProbe;
  readonly directorySnapshot: DirectorySnapshotEntry;
  readonly preflightResults: readonly PreflightResult[];
  readonly designerDomSnapshot: unknown;
}

// ── 预检结果操作 ──────────────────────────────────────

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function normalizeSeverity(value: unknown): PreflightSeverity {
  const s = String(value || '');
  return (s === 'blocker' || s === 'warning' || s === 'info') ? s as PreflightSeverity : 'info';
}

export function createPreflightResult(input: Record<string, unknown> = {}): PreflightResult {
  return {
    operationId: cleanInlineText(String(input.operationId ?? '')),
    checkId: cleanInlineText(String(input.checkId ?? '')),
    severity: normalizeSeverity(input.severity),
    ok: input.ok !== false,
    errorCode: cleanInlineText(String(input.errorCode ?? '')),
    evidence: cleanMultilineText(String(input.evidence ?? '')),
    nextAction: cleanMultilineText(String(input.nextAction ?? '')),
    data: normalizeObject(input.data),
  };
}

export function hasBlockingPreflightResult(results: readonly PreflightResult[] | unknown): boolean {
  return normalizeArray<PreflightResult>(results).some(
    (r) => r.severity === 'blocker' && !r.ok,
  );
}

function formatPreflightResultLine(result: PreflightResult): string {
  const parts = [
    `operationId=${result.operationId || 'unknown'}`,
    `checkId=${result.checkId || 'unknown'}`,
    `severity=${result.severity}`,
    `ok=${result.ok}`,
  ];
  if (result.errorCode) parts.push(`errorCode=${result.errorCode}`);
  if (result.evidence) parts.push(`evidence=${result.evidence}`);
  if (result.nextAction) parts.push(`nextAction=${result.nextAction}`);
  return parts.join(' | ');
}

export function formatPreflightStatusLines(results: readonly PreflightResult[] | unknown): readonly string[] {
  const normalized = (normalizeArray(results) as unknown as readonly Record<string, unknown>[])
    .map((r) => createPreflightResult(r));
  if (!normalized.length) return ['preflightResults=empty'];
  return ['preflightResults:', ...normalized.map(formatPreflightResultLine)];
}

// ── 文件风险 ──────────────────────────────────────────

export interface WritebackRiskInput {
  readonly operationId?: string;
  readonly checkId?: string;
  readonly fileName?: string;
  readonly size?: number;
  readonly modifiedAt?: string;
}

export function createWritebackRiskResult(input: WritebackRiskInput = {}): PreflightResult {
  const fileName = cleanInlineText(input.fileName ?? '');
  const evidence = [
    fileName ? `fileName=${fileName}` : '',
    Number.isFinite(Number(input.size)) ? `size=${Number(input.size)}` : '',
    input.modifiedAt ? `modifiedAt=${cleanInlineText(input.modifiedAt)}` : '',
  ].filter(Boolean).join(' | ');

  return createPreflightResult({
    operationId: input.operationId,
    checkId: input.checkId || 'writeback.localFileRisk',
    severity: 'warning',
    ok: true,
    errorCode: '',
    evidence,
    nextAction: '',
    data: {
      fileName,
      size: Number.isFinite(Number(input.size)) ? Number(input.size) : null,
      modifiedAt: cleanInlineText(input.modifiedAt ?? ''),
    },
  });
}

// ── 快照消毒 ──────────────────────────────────────────

const DEFAULT_DIRECTORY_FILE_LIMIT = 80;

export function sanitizeDirectorySnapshot(
  input: Record<string, unknown> = {},
  options: { maxFiles?: number } = {},
): DirectorySnapshotEntry {
  const maxFiles = Number.isInteger(options.maxFiles) ? Math.max(0, options.maxFiles!) : DEFAULT_DIRECTORY_FILE_LIMIT;
  const files = (normalizeArray(input.files) as unknown as Array<Record<string, unknown>>)
    .slice(0, maxFiles)
    .map((f) => ({
      fileName: cleanInlineText(String(f.fileName ?? '')),
      exists: f.exists === true,
      size: Number.isFinite(Number(f.size)) ? Number(f.size) : null,
      modifiedAt: cleanInlineText(String(f.modifiedAt ?? '')),
    }));

  return {
    accessMode: cleanInlineText(String(input.accessMode ?? '')),
    targetPath: cleanInlineText(String(input.targetPath ?? '')),
    fileLimit: maxFiles,
    truncated: (normalizeArray(input.files) as readonly unknown[]).length > maxFiles,
    files,
  };
}

export function sanitizePageProbe(input: Record<string, unknown> = {}): PageProbe {
  const monacoModels = (normalizeArray(input.monacoModels) as unknown as Array<Record<string, unknown>>)
    .map((m: Record<string, unknown>) => ({
      selector: cleanInlineText(String(m.selector ?? '')),
      codeKind: cleanInlineText(String(m.codeKind ?? '')),
      mounted: m.mounted === true,
      modelCount: Number.isFinite(Number(m.modelCount)) ? Number(m.modelCount) : null,
      editorCount: Number.isFinite(Number(m.editorCount)) ? Number(m.editorCount) : null,
      selectedStrategy: cleanInlineText(String(m.selectedStrategy ?? '')),
      languageIds: (normalizeArray(m.languageIds) as readonly string[]).map((s: string) => cleanInlineText(s)).filter(Boolean),
      sourceLength: Number.isFinite(Number(m.sourceLength)) ? Number(m.sourceLength) : null,
      errorCode: cleanInlineText(String(m.errorCode ?? '')),
      diagnostic: cleanInlineText(String(m.diagnostic ?? '')),
    }));

  return {
    url: cleanInlineText(String(input.url ?? '')),
    title: cleanInlineText(String(input.title ?? '')),
    platformKey: cleanInlineText(String(input.platformKey ?? '')),
    pageType: cleanInlineText(String(input.pageType ?? '')),
    pageLabel: cleanInlineText(String(input.pageLabel ?? '')),
    monacoModels,
  };
}

// ── 诊断包构建 ───────────────────────────────────────

export function buildDiagnosticPackage(input: Record<string, unknown> = {}): DiagnosticPackage {
  const createdAt = cleanInlineText(String(input.createdAt ?? '')) || new Date().toISOString();
  const extObj = normalizeObject(input.extension);
  const browserObj = normalizeObject(input.browser);

  return {
    schemaVersion: 1,
    createdAt,
    operationId: cleanInlineText(String(input.operationId ?? '')),
    extension: {
      name: cleanInlineText(String(extObj.name ?? '')),
      version: cleanInlineText(String(extObj.version ?? '')),
    },
    browser: {
      userAgent: cleanInlineText(String(browserObj.userAgent ?? '')),
    },
    logs: (normalizeArray(input.logs) as unknown as Array<Record<string, unknown>>).map((log: Record<string, unknown>) => ({
      time: cleanInlineText(String(log.time ?? '')),
      level: cleanInlineText(String(log.level ?? '')),
      lines: (normalizeArray(log.lines) as readonly string[]).map((s: string) => cleanMultilineText(s)),
      suggestion: cleanMultilineText(String(log.suggestion ?? '')),
      context: normalizeObject(log.context),
    })),
    pageProbe: sanitizePageProbe(normalizeObject(input.pageProbe)),
    directorySnapshot: sanitizeDirectorySnapshot(normalizeObject(input.directorySnapshot)),
    preflightResults: (normalizeArray(input.preflightResults) as unknown as Array<Record<string, unknown>>)
      .map((item: Record<string, unknown>) => createPreflightResult(item)),
    designerDomSnapshot: input.designerDomSnapshot || null,
  };
}

export async function saveLastDiagnosticPackage(packageData: Record<string, unknown>): Promise<DiagnosticPackage> {
  if (!globalThis.chrome?.storage?.local) {
    return buildDiagnosticPackage(packageData);
  }
  const pkg = buildDiagnosticPackage(packageData);
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_DIAGNOSTIC]: pkg });
  return pkg;
}

export async function loadLastDiagnosticPackage(): Promise<DiagnosticPackage | null> {
  if (!globalThis.chrome?.storage?.local) return null;
  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.LAST_DIAGNOSTIC]: null });
  const data = stored?.[STORAGE_KEYS.LAST_DIAGNOSTIC];
  return data ? buildDiagnosticPackage(data) : null;
}

// ── 摘要 ──────────────────────────────────────────────

export function summarizeDiagnosticPackage(packageData: Record<string, unknown> = {}): string {
  const pkg = buildDiagnosticPackage(packageData);
  const blockers = pkg.preflightResults.filter((r) => r.severity === 'blocker' && !r.ok).length;
  const warnings = pkg.preflightResults.filter((r) => r.severity === 'warning').length;
  return [
    `createdAt=${pkg.createdAt}`,
    `operationId=${pkg.operationId || 'unknown'}`,
    `extensionVersion=${pkg.extension.version || 'unknown'}`,
    `blockers=${blockers}`,
    `warnings=${warnings}`,
    `targetPath=${pkg.directorySnapshot.targetPath}`,
  ].join('\n');
}
