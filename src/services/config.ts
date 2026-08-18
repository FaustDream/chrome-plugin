/**
 * 配置管理模块。
 *
 * 负责加载、清洗、持久化扩展配置（存储于 chrome.storage.local）。
 * resolvePageTypeConfig() 不依赖 DOM，只解析 URL，可被 background 与 popup 同时调用且结果一致。
 *
 * **注意**：本模块引用 chrome.storage，严格来说应在 src/ 下。
 * 当前保留在 lib/ 以匹配原始项目结构，后续重构时移至 src/shared/。
 */
import type { GeneratedFilesConfig, ExtensionConfig } from '../types/config.js';
import type { PlatformKey, PageType, PageTypeConfig, FileMapping } from '../types/platform.js';
import {
  PLATFORM_LABELS,
  PLATFORM_HOST_MAP,
  CLOUDPIVOT_FILE_MAPPINGS,
  STORAGE_KEYS,
} from '../lib/constants.js';
import { normalizePath } from '../lib/utils.js';

// ── 常量 ──────────────────────────────────────────────

const DEFAULT_GENERATED_FILES: Record<PlatformKey, GeneratedFilesConfig> = {
  cloudpivot: { fromCode: true, css: true, js: true, html: true, readme: false, agents: false, design: false },
  h3yun: { fromCode: true, js: true, cs: true, readme: false, agents: false, design: false },
};

// ── 页面类型配置表 ────────────────────────────────────

interface PageTypeEntry {
  readonly platformKey: PlatformKey;
  readonly pageType: PageType;
  readonly pageLabel: string;
  readonly componentName: string;
  readonly fileMappings: readonly FileMapping[];
}

const PAGE_TYPE_CONFIG_TABLE: Record<string, PageTypeEntry> = {
  form: {
    platformKey: 'cloudpivot',
    pageType: 'form',
    pageLabel: '表单在线开发',
    componentName: 'editor',
    fileMappings: CLOUDPIVOT_FILE_MAPPINGS.map((m) => ({ ...m })),
  },
  list: {
    platformKey: 'cloudpivot',
    pageType: 'list',
    pageLabel: '列表在线开发',
    componentName: 'ListEditor',
    fileMappings: [
      { key: 'html', fileName: 'list-index.html' },
      { key: 'css', fileName: 'list-style.css' },
      { key: 'javascript', fileName: 'list-script.js' },
    ],
  },
  default: {
    platformKey: 'cloudpivot',
    pageType: 'default',
    pageLabel: '默认页面',
    componentName: 'editor',
    fileMappings: [
      { key: 'html', fileName: 'index.html' },
      { key: 'css', fileName: 'style.css' },
      { key: 'javascript', fileName: 'script.js' },
    ],
  },
  h3yunForm: {
    platformKey: 'h3yun',
    pageType: 'h3yunForm',
    pageLabel: '氚云表单设计',
    componentName: '',
    fileMappings: [],
  },
  h3yunList: {
    platformKey: 'h3yun',
    pageType: 'h3yunList',
    pageLabel: '氚云列表设计',
    componentName: '',
    fileMappings: [],
  },
  h3yunDefault: {
    platformKey: 'h3yun',
    pageType: 'h3yunDefault',
    pageLabel: '氚云页面',
    componentName: '',
    fileMappings: [],
  },
};

// ── 平台只读设置 ──────────────────────────────────────

export const CLOUDPIVOT_READONLY_SETTINGS: readonly string[] = [
  '前端抓取写入：按页面类型写入固定文件名（form-index.html / form-style.css / form-script.js 等）',
  '前端回写：将本地 HTML / CSS / JS 通过 data.codes 同步回在线编辑器',
  '业务规则抓取写入：通过 Monaco API 读取 Java 源码，按 model URI 或类名写入 .java 文件，并补齐 AI 协作文件',
  '业务规则回写：同页多开业务规则时按同名 model 回写，单页仅支持一个业务规则编辑器',
  '平台互通：云枢 JS 只能通过业务规则传参协作，不按 Ajax 直连后端生成方案',
  '目录规则：更新目标目录会同步当前页面快照和后续新页面默认值，旧页面保持原绑定',
];

export const H3YUN_READONLY_SETTINGS: readonly string[] = [
  '一键抓取写入：读取控件信息、#jsText 前端 JS、#csText 后端 C#，并补齐 README.md / AGENTS.md / DESIGN.md / FromCode.md',
  '平台互通：氚云前端 JS 与后端 C# 通过 Ajax 传参互通，前后端逻辑需要成对设计',
  '前端代码回写：将本地 {表单ID}.js 通过 Monaco model API 回写到 #jsText',
  '后端代码回写：将本地 C# 类名 .cs 通过 Monaco model API 回写到 #csText',
  '模型匹配：氚云 Monaco model 语言 ID 为 undefined，先按内容正则区分 JS/C#，多 model 命中时按容器挂载、Monaco 版本号、创建顺序和长度评分',
];

export const READONLY_SETTINGS: readonly string[] = [
  ...CLOUDPIVOT_READONLY_SETTINGS,
  ...H3YUN_READONLY_SETTINGS,
];

// ── URL 解析（不依赖 chrome.*，纯逻辑） ────────────────

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch (_error) {
    return null;
  }
}

/** 根据域名识别平台 */
export function resolvePlatformKey(pageUrl: string): PlatformKey {
  const parsed = safeUrl(pageUrl);
  if (!parsed) return 'cloudpivot';
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'h3yun.com' || hostname.endsWith('.h3yun.com')) return 'h3yun';
  if (hostname === 'ztna-dingtalk.com' || hostname.endsWith('.ztna-dingtalk.com')) return 'cloudpivot';
  return 'cloudpivot';
}

/** 判断 URL 是否属于已知平台 */
export function isRecognizedPlatformUrl(pageUrl: string): boolean {
  const parsed = safeUrl(pageUrl);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  return hostname === 'h3yun.com' || hostname.endsWith('.h3yun.com')
    || hostname === 'ztna-dingtalk.com' || hostname.endsWith('.ztna-dingtalk.com');
}

/** 根据 URL 解析页面类型配置 */
export function resolvePageTypeConfig(pageUrl: string): PageTypeConfig | null {
  const normalizedUrl = String(pageUrl || '').toLowerCase();
  const platformKey = resolvePlatformKey(pageUrl);

  if (platformKey === 'h3yun') {
    if (normalizedUrl.includes('list-designer.html') || normalizedUrl.includes('list-design')) {
      return buildPageTypeConfig(PAGE_TYPE_CONFIG_TABLE.h3yunList!);
    }
    if (normalizedUrl.includes('form-designer.html') || normalizedUrl.includes('form-design')) {
      return buildPageTypeConfig(PAGE_TYPE_CONFIG_TABLE.h3yunForm!);
    }
    return buildPageTypeConfig(PAGE_TYPE_CONFIG_TABLE.h3yunDefault!);
  }

  if (normalizedUrl.includes('list-designer.html') || normalizedUrl.includes('list-design')) {
    return buildPageTypeConfig(PAGE_TYPE_CONFIG_TABLE.list!);
  }
  if (normalizedUrl.includes('form-designer.html') || normalizedUrl.includes('form-design')) {
    return buildPageTypeConfig(PAGE_TYPE_CONFIG_TABLE.form!);
  }
  return buildPageTypeConfig(PAGE_TYPE_CONFIG_TABLE.default!);
}

function buildPageTypeConfig(entry: PageTypeEntry): PageTypeConfig {
  return {
    platformKey: entry.platformKey,
    pageType: entry.pageType,
    pageLabel: entry.pageLabel,
    fileMappings: [...entry.fileMappings],
    isRecognizedPlatformUrl: true,
  };
}

/** 根据页面类型推导所属平台 Key */
export function getPlatformKeyFromPageType(pageType: string): PlatformKey {
  const normalized = String(pageType || '').trim().toLowerCase();
  return normalized.startsWith('h3yun') ? 'h3yun' : 'cloudpivot';
}

/** 氚云设计模式判断 */
export function resolveH3yunDesignMode(pageTypeConfig: PageTypeConfig | null): 'form' | 'list' | 'unknown' {
  if (pageTypeConfig?.pageType === 'h3yunForm') return 'form';
  if (pageTypeConfig?.pageType === 'h3yunList') return 'list';
  return 'unknown';
}

// ── 配置读写（依赖 chrome.storage） ───────────────────

function normalizeFallbackDirectoryPaths(value: unknown): Partial<Record<PlatformKey, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { cloudpivot: '', h3yun: '' };
  }
  const obj = value as Record<string, unknown>;
  return {
    cloudpivot: normalizePath(obj.cloudpivot),
    h3yun: normalizePath(obj.h3yun),
  };
}

function normalizeGeneratedFiles(value: unknown): Record<PlatformKey, GeneratedFilesConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_GENERATED_FILES;
  }
  const obj = value as Record<string, unknown>;
  const result: Record<string, GeneratedFilesConfig> = {};
  for (const [platformKey, defaults] of Object.entries(DEFAULT_GENERATED_FILES)) {
    const pVal = obj[platformKey];
    if (!pVal || typeof pVal !== 'object') {
      result[platformKey] = { ...defaults };
      continue;
    }
    const platformObj = pVal as Record<string, boolean>;
    // 显式逐字段归一化为 boolean，构建满足 GeneratedFilesConfig 形状的对象
    result[platformKey] = {
      fromCode: platformObj.fromCode === true,
      readme: platformObj.readme === true,
      agents: platformObj.agents === true,
      design: platformObj.design === true,
      css: platformObj.css === true,
      js: platformObj.js === true,
      html: platformObj.html === true,
      cs: platformObj.cs === true,
    };
  }
  return result as Record<PlatformKey, GeneratedFilesConfig>;
}

export async function loadConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get({
    h3yunOneClickWriteback: true,
    generatedFiles: DEFAULT_GENERATED_FILES,
    fallbackDirectoryPaths: { cloudpivot: '', h3yun: '' },
  });
  return {
    h3yunOneClickWriteback: stored.h3yunOneClickWriteback !== false,
    generatedFiles: normalizeGeneratedFiles(stored.generatedFiles),
    fallbackDirectoryPaths: normalizeFallbackDirectoryPaths(stored.fallbackDirectoryPaths),
  };
}

export async function saveConfig(partial: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const current = await loadConfig();
  const next: Record<string, unknown> = {};
  if ('h3yunOneClickWriteback' in partial) next.h3yunOneClickWriteback = partial.h3yunOneClickWriteback === true;
  if ('generatedFiles' in partial) next.generatedFiles = normalizeGeneratedFiles(partial.generatedFiles);
  if ('fallbackDirectoryPaths' in partial) next.fallbackDirectoryPaths = normalizeFallbackDirectoryPaths(partial.fallbackDirectoryPaths);

  // chrome.storage.set 接受扁平键值对象；merged 形状与 ExtensionConfig 一致
  const merged = { ...current, ...next };
  await chrome.storage.local.set(merged as unknown as Record<string, unknown>);
  return merged as ExtensionConfig;
}

export function getFallbackDirectoryPathByPlatform(
  config: ExtensionConfig,
  platformKey: PlatformKey,
): string {
  return normalizePath(config.fallbackDirectoryPaths[platformKey]);
}

// ── 页类型默认目录（持久化于 chrome.storage.local） ─────

const PAGE_TYPE_DIRECTORY_PATHS_KEY = 'targetDirectoryPageTypePaths';

interface PageTypeDirectoryPaths {
  [pageType: string]: string;
}

function normalizePageTypeDirectoryPaths(value: unknown): PageTypeDirectoryPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const result: PageTypeDirectoryPaths = {};
  for (const [pageType, path] of Object.entries(obj)) {
    const p = normalizePath(path);
    if (p) result[String(pageType || '').trim()] = p;
  }
  return result;
}

/** 按页类型读取全局默认目录 */
export async function getTargetDirectoryPathByPageType(pageType: string): Promise<string> {
  const normalized = String(pageType || '').trim();
  if (!normalized) return '';
  const stored = await chrome.storage.local.get({ [PAGE_TYPE_DIRECTORY_PATHS_KEY]: {} });
  const paths = normalizePageTypeDirectoryPaths(stored[PAGE_TYPE_DIRECTORY_PATHS_KEY]);
  return paths[normalized] || '';
}

/** 按页类型保存全局默认目录 */
export async function saveTargetDirectoryPathByPageType(
  pageType: string,
  targetDirectoryPath: string,
): Promise<void> {
  const normalized = String(pageType || '').trim();
  if (!normalized) return;

  const stored = await chrome.storage.local.get({ [PAGE_TYPE_DIRECTORY_PATHS_KEY]: {} });
  const paths = normalizePageTypeDirectoryPaths(stored[PAGE_TYPE_DIRECTORY_PATHS_KEY]);
  const path = normalizePath(targetDirectoryPath);

  if (path) {
    paths[normalized] = path;
  } else {
    delete paths[normalized];
  }

  await chrome.storage.local.set({ [PAGE_TYPE_DIRECTORY_PATHS_KEY]: paths });
}
