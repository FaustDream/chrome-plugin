/**
 * 扩展配置形状（chrome.storage.local 持久化的用户设置）。
 */

import type { PlatformKey } from './platform.js';

/** 协作文档生成开关（按平台） */
export interface GeneratedFilesConfig {
  readonly fromCode: boolean;
  readonly readme: boolean;
  readonly agents: boolean;
  readonly design: boolean;
  /** 云枢专有 */
  readonly css?: boolean;
  readonly js?: boolean;
  readonly html?: boolean;
  /** 氚云专有 */
  readonly cs?: boolean;
}

export interface ExtensionConfig {
  readonly h3yunOneClickWriteback: boolean;
  readonly generatedFiles: Record<PlatformKey, GeneratedFilesConfig>;
  /** 平台兜底目录路径 */
  readonly fallbackDirectoryPaths: Partial<Record<PlatformKey, string>>;
}
