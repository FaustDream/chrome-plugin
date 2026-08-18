/**
 * AI 协作文档生成服务。
 *
 * 负责在目录中按需补建 README.md / AGENTS.md / DESIGN.md。
 * 设计原则：已有内容不覆盖（只补建缺失文件），让用户保留自己的手写内容。
 */

import { cleanInlineText, cleanMultilineText } from '../lib/utils.js';

// ── 常量 ──────────────────────────────────────────────

export const WORKSPACE_DOCUMENT_FILE_NAMES = {
  readme: 'README.md',
  agents: 'AGENTS.md',
  design: 'DESIGN.md',
  fromCode: 'FromCode.md',
} as const;

// ── 类型 ──────────────────────────────────────────────

export interface WorkspaceDocumentInput {
  readonly platformKey?: string;
  readonly platformLabel?: string;
  readonly pageLabel?: string;
  readonly pageUrl?: string;
  readonly appCode?: string;
  readonly applicationCode?: string;
  readonly applicationName?: string;
  readonly appName?: string;
  readonly formCode?: string;
  readonly formId?: string;
  readonly formName?: string;
  readonly mainTableCode?: string;
  readonly codeFiles?: readonly string[];
}

export interface WorkspaceDocumentState {
  readonly hasReadme: boolean;
  readonly hasAgents: boolean;
  readonly hasDesign: boolean;
}

export interface WorkspaceDocumentOptions {
  readonly generatedFiles?: Partial<Record<string, boolean>>;
  readonly extraDocs?: Partial<Record<string, boolean>>;
}

export interface WorkspaceDocumentFile {
  readonly fileName: string;
  readonly content: string;
}

// ── 工具 ──────────────────────────────────────────────

function normalizePlatformKey(value: unknown): string {
  return value === 'h3yun' ? 'h3yun' : 'cloudpivot';
}

function resolvePlatformLabel(input: WorkspaceDocumentInput): string {
  const label = cleanInlineText(input.platformLabel ?? '');
  return label || (normalizePlatformKey(input.platformKey) === 'h3yun' ? '氚云' : '云枢');
}

function appendOptionalLine(lines: string[], label: string, value: string | undefined): void {
  const v = cleanInlineText(value ?? '');
  if (v) lines.push(`- ${label}：${v}`);
}

function buildBasicInfoLines(input: WorkspaceDocumentInput): string[] {
  const lines = [
    `- 平台：${resolvePlatformLabel(input)}`,
    `- 页面类型：${cleanInlineText(input.pageLabel ?? '') || '未识别'}`,
  ];
  appendOptionalLine(lines, '页面地址', input.pageUrl);
  appendOptionalLine(lines, '应用编码', input.appCode ?? input.applicationCode);
  appendOptionalLine(lines, '应用名称', input.appName ?? input.applicationName);
  appendOptionalLine(lines, '表单编码', input.formCode);
  appendOptionalLine(lines, '表单ID', input.formId);
  appendOptionalLine(lines, '表单名称', input.formName);
  appendOptionalLine(lines, '主表编码', input.mainTableCode);
  return lines;
}

function buildCodeFileLines(input: WorkspaceDocumentInput): string[] {
  const codeFiles = Array.isArray(input.codeFiles)
    ? input.codeFiles.map(cleanInlineText).filter(Boolean)
    : [];

  if (!codeFiles.length) {
    return ['- 待 AI 根据 `README.md`、`FromCode.md` 和当前平台规则确认。'];
  }

  const frontendFiles: string[] = [];
  const backendFiles: string[] = [];
  for (const fileName of codeFiles) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.java') || lower.endsWith('.cs')) {
      backendFiles.push(`- \`${fileName}\``);
    } else {
      frontendFiles.push(`- \`${fileName}\``);
    }
  }

  const lines: string[] = [];
  if (frontendFiles.length) lines.push('**前端文件**', ...frontendFiles);
  if (backendFiles.length) {
    if (lines.length) lines.push('');
    lines.push('**服务端文件**', ...backendFiles);
  }
  return lines.length ? lines : codeFiles.map((f) => `- \`${f}\``);
}

function buildPlatformAgentsRules(input: WorkspaceDocumentInput): string[] {
  if (normalizePlatformKey(input.platformKey) === 'h3yun') {
    return [
      '- 氚云代码包含前端 `.js` 与后端 `.cs`；涉及跨端逻辑时必须同时检查两端。',
      '- 前端 JS 通过 Ajax 与后端 C# 互通，参数名、返回字段和错误信息必须在 `DESIGN.md` 中写清楚。',
      '- 只改前端展示且不需要服务端数据时，可以不改 C#，但要在 `DESIGN.md` 标注原因。',
    ];
  }
  return [
    '- 云枢代码包含前端 HTML/CSS/JS 和业务规则 Java；两类文件通过业务规则传参协作。',
    '- 云枢 JS 不写 Ajax 直连后端，需要服务端逻辑时先设计业务规则入参、返回值和异常提示。',
    '- 业务规则 Java 改动必须说明数据查询、写入、校验或状态流转原因。',
    ' - 本文件夹下面的java代码都需要增加每次调用往本文件夹对应的表单写入一条日志数据。 ',
    '- java文件代码每次新增的java文件都是向DESIGN.md追加业务逻辑 ',
    '- 响应示例的编码都要加上中文名称注释 ',
    ' - **Java 注释**：只写业务逻辑含义，禁止出现参见 DESIGN.md 某章节等跨文档引用。',
    '- **DESIGN.md**：按 Java 类或功能模块分章节组织，每个类/模块独立成节，避免所有实现逻辑杂糅在一起。',
  ];
}

// ── 内容生成 ──────────────────────────────────────────

export function buildWorkspaceReadmeContent(_input: WorkspaceDocumentInput = {}): string {
  return '# 需求文档\n';
}

export function buildWorkspaceAgentsContent(input: WorkspaceDocumentInput = {}): string {
  return [
    '# 当前目录 Agent 规则',
    '',
    '## 文件职责',
    '',
    '- **README.md**：用户写业务需求，AI 只读不写。',
    '- **FromCode.md**：插件抓取字段/控件/表单编码，人工只补业务含义，AI 只读不写。',
    '- **DESIGN.md**：AI 根据 README + FromCode 自动生成和维护技术实现方案。',
    '- **AGENTS.md**：用户写本目录的 AI 执行规则和约束，AI 执行前必读。',
    '',
    '## 执行顺序',
    '',
    '0. 先读根目录的 `AGENTS.md`，确认根目录整个项目的 Agent 规则。',
    '1. 先读 `README.md`，确认用户业务需求和验收标准。',
    '2. 再读 `FromCode.md`，确认字段编码、控件名称、控件类型和表单上下文。',
    '3. 在 `DESIGN.md` 中整理实现方案、状态流转、参数传递、涉及文件和验证方式。',
    '4. 按本目录平台约束修改代码文件，避免改动无关文件。',
    '',
    '## 平台约束',
    '',
    ...buildPlatformAgentsRules(input),
    '',
    '## 注释与验证',
    '',
    '- 修改 JS、CSS、Java 或 C# 时补充有业务价值的中文注释，说明用途、关键变量、状态流转和外部调用原因。',
    '- 未实际执行验证时，不得声称已经通过；无法验证时在 `DESIGN.md` 或交付说明中写明原因。',
  ].join('\n') + '\n';
}

export function buildWorkspaceDesignContent(input: WorkspaceDocumentInput = {}): string {
  return [
    '# 实现设计',
    '',
    '> 文件用途：AI 根据 `README.md` 中的用户需求和 `FromCode.md` 中的编码上下文，生成并维护对应代码逻辑。插件只在文件缺失时创建本模板。',
    '',
    '## 需求来源',
    '',
    '- 用户需求：读取并引用 `README.md`。',
    '- 编码上下文：读取并引用 `FromCode.md`。',
    '',
    '## 基本信息',
    '',
    ...buildBasicInfoLines(input),
    '',
    '## 涉及代码文件',
    '',
    ...buildCodeFileLines(input),
  ].join('\n') + '\n';
}

// ── 门控生成 ──────────────────────────────────────────

/**
 * 按生成开关门控生成协作文件。
 * 已有内容不覆盖（只补建缺失文件）。
 */
export function buildMissingWorkspaceDocumentFiles(
  input: WorkspaceDocumentInput = {},
  state: WorkspaceDocumentState = { hasReadme: false, hasAgents: false, hasDesign: false },
  options: WorkspaceDocumentOptions = {},
): WorkspaceDocumentFile[] {
  const extraDocs = options.extraDocs ?? {};
  const generatedFiles = options.generatedFiles ?? {};

  const shouldGenerate = (key: string): boolean => {
    if (typeof extraDocs[key] === 'boolean') return extraDocs[key];
    if (typeof generatedFiles[key] === 'boolean') return generatedFiles[key];
    return false;
  };

  const files: WorkspaceDocumentFile[] = [];

  if (!state.hasReadme && shouldGenerate('readme')) {
    files.push({
      fileName: WORKSPACE_DOCUMENT_FILE_NAMES.readme,
      content: buildWorkspaceReadmeContent(input),
    });
  }

  if (!state.hasAgents && shouldGenerate('agents')) {
    files.push({
      fileName: WORKSPACE_DOCUMENT_FILE_NAMES.agents,
      content: buildWorkspaceAgentsContent(input),
    });
  }

  if (!state.hasDesign && shouldGenerate('design')) {
    files.push({
      fileName: WORKSPACE_DOCUMENT_FILE_NAMES.design,
      content: buildWorkspaceDesignContent(input),
    });
  }

  return files.map((f) => ({
    fileName: f.fileName,
    content: `${cleanMultilineText(f.content)}\n`,
  }));
}
