/**
 * 平台 / 页面类型 / 代码条目等纯数据形状。
 *
 * 这些是跨模块共享的「数据契约」：注入函数产出它们、操作编排消费它们、
 * lib 解析它们。只放纯类型与字面量联合，不放运行时常量（常量在 lib/constants）。
 */

/** 支持的平台标识（与原生 config.js 的 platformKey 对齐） */
export type PlatformKey = 'cloudpivot' | 'h3yun';

/**
 * 页面类型。云枢 3 种 + 氚云 3 种。
 * 注意：氚云列表设计页无图形控件，独立成 h3yunList 以避免误报「没有图形控件」。
 */
export type PageType =
  | 'form'
  | 'list'
  | 'default'
  | 'h3yunForm'
  | 'h3yunList'
  | 'h3yunDefault';

/** 代码端：前端 / 后端 */
export type CodeKind = 'frontend' | 'backend';

/** 源码语言标识 */
export type SourceLanguage = 'html' | 'css' | 'javascript' | 'csharp' | 'java';

/** 云枢固定文件映射：编辑器内容 → 本地文件名 */
export interface FileMapping {
  readonly key: SourceLanguage;
  readonly fileName: string;
}

/**
 * 抓取/回写的基本代码单元。
 * 云枢前端按 fileMappings 落固定文件名；氚云/业务规则按动态推断文件名。
 */
export interface CodeEntry {
  readonly fileName: string;
  readonly codeKind: CodeKind;
  readonly sourceLanguage: SourceLanguage;
  readonly sourceContent: string;
  readonly uri?: string;
  readonly language?: string;
}

/** 控件元数据（用于 FromCode / README 生成） */
export interface ControlMeta {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly isSubtable: boolean;
  /** 子表字段编码列表（仅子表控件有） */
  readonly childCodes?: readonly string[];
  /** 选项/枚举值（下拉/单选等） */
  readonly options?: readonly string[];
}

/** 页面类型解析结果（resolvePageTypeConfig 的返回形状） */
export interface PageTypeConfig {
  readonly platformKey: PlatformKey;
  readonly pageType: PageType;
  readonly pageLabel: string;
  readonly fileMappings: readonly FileMapping[];
  /** 是否为已识别的平台 URL（false 表示非平台页，UI 应禁用操作） */
  readonly isRecognizedPlatformUrl: boolean;
}

/** 当前活动标签页 + 解析后的页面配置（popup 会话内传递的上下文） */
export interface PageContext {
  readonly tab: { readonly id?: number; readonly url?: string; readonly title?: string };
  readonly pageTypeConfig: PageTypeConfig | null;
  readonly pageType: PageType | 'unknown';
}
