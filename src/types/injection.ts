/**
 * 注入函数的入参与返回类型契约。
 *
 * 重要约束：注入函数通过 chrome.scripting.executeScript({ world:'MAIN' }) 在
 * 目标页面执行，返回值经结构化克隆回传。因此返回结构必须是「可克隆的纯数据」
 * （无函数、无 DOM 节点、无循环引用）——注入函数内部要用 sanitize 保证。
 *
 * 每个注入函数都遵循统一外壳：成功 { ok:true, ... }，失败 { ok:false, errorCode, ... }。
 */

import type { ControlMeta } from './platform.js';

/** 注入函数失败时的统一错误外壳 */
export interface InjectionFailure {
  readonly ok: false;
  readonly errorCode: string;
  readonly details?: string;
  readonly debugLog?: string;
}

// ─── 云枢前端抓取 pageCaptureMain ───────────────────────────────

export interface PageCaptureInput {
  /** 候选 Vue 组件名，默认 ["editor"]，列表页传 ["ListEditor"] */
  readonly candidateComponentNames?: readonly string[];
}

/** 云枢 data.codes 三键结构（与原生 Vue 组件 $data.codes 对齐） */
export interface CloudpivotCodes {
  readonly html?: string;
  readonly css?: string;
  readonly javascript?: string;
}

export interface PageCaptureSuccess {
  readonly ok: true;
  readonly pageUrl: string;
  readonly candidateCount: number;
  readonly discoveredComponentNames: readonly string[];
  /** sanitize 后的组件 data，含 codes 三键 */
  readonly data: { readonly codes?: CloudpivotCodes; readonly [key: string]: unknown };
  readonly metadata: Record<string, unknown>;
}

export type PageCaptureResult = PageCaptureSuccess | InjectionFailure;

// ─── 云枢前端回写 pageWritebackMain ─────────────────────────────

export interface PageWritebackInput {
  readonly candidateComponentNames?: readonly string[];
  readonly codeEntries: readonly { readonly key: string; readonly content: string }[];
}

export interface PageWritebackSuccess {
  readonly ok: true;
  readonly updatedKeys: readonly string[];
  readonly compatibilityState: Record<string, unknown>;
}

export type PageWritebackResult = PageWritebackSuccess | InjectionFailure;

// ─── 云枢业务规则 bizRuleProbeMain / bizRuleWritebackMain ───────

export interface BizRuleProbeInput {
  /** 期望匹配的文件名（回写时用于定位 model） */
  readonly fileName?: string;
}

export interface BizRuleProbeSuccess {
  readonly ok: true;
  readonly sourceContent: string;
  readonly fileName: string;
  readonly className: string;
  readonly language: string;
  readonly uri: string;
  /** 注入实现附带诊断字段（与 gitHub 原版规则一致，popup 成功日志展示用） */
  readonly hasMonacoGlobal: boolean;
  readonly editorCount: number;
  readonly modelCount: number;
  readonly sourceLength: number;
  readonly sampleText: string;
  readonly details: readonly string[];
}

export type BizRuleProbeResult = BizRuleProbeSuccess | InjectionFailure;

export interface BizRuleWritebackInput {
  readonly fileName: string;
  readonly sourceContent: string;
}

export interface BizRuleWritebackSuccess {
  readonly ok: true;
  readonly fileName: string;
  readonly sourceLength: number;
  /** 注入实现附带诊断字段（与 gitHub 原版规则一致，popup 成功日志展示用） */
  readonly language: string;
  readonly uri: string;
  readonly editorCount: number;
  readonly modelCount: number;
  readonly details: readonly string[];
}

export type BizRuleWritebackResult = BizRuleWritebackSuccess | InjectionFailure;

// ─── 氚云代码编辑器 h3yunCodeEditorProbeMain / Writeback ────────

export interface H3yunCodeEditorProbeInput {
  /** 容器选择器，前端 "#jsText"，后端 "#csText" */
  readonly selector: string;
  readonly codeKind: 'frontend' | 'backend';
}

export interface H3yunCodeEditorProbeSuccess {
  readonly ok: true;
  readonly pageUrl: string;
  readonly selector: string;
  readonly language: string;
  readonly uri: string;
  readonly sourceContent: string;
  readonly sourceLength: number;
  readonly editorCount: number;
  readonly modelCount: number;
  readonly readMethod: 'monaco-api' | 'view-lines-dom';
  readonly diagnostic: string;
  readonly debugLog: string;
}

export type H3yunCodeEditorProbeResult = H3yunCodeEditorProbeSuccess | InjectionFailure;

export interface H3yunCodeEditorWritebackInput {
  readonly selector: string;
  readonly codeKind: 'frontend' | 'backend';
  readonly sourceContent: string;
}

export interface H3yunCodeEditorWritebackSuccess {
  readonly ok: true;
  readonly pageUrl: string;
  readonly selector: string;
  readonly sourceLength: number;
  readonly writableCount: number;
  readonly debugLog: string;
}

export type H3yunCodeEditorWritebackResult = H3yunCodeEditorWritebackSuccess | InjectionFailure;

// ─── 氚云设计器元数据 h3yunDesignerMetadataMain ─────────────────

export interface H3yunDesignerMetadataSuccess {
  readonly ok: true;
  readonly pageUrl: string;
  readonly controls: readonly ControlMeta[];
  readonly appCode: string;
  readonly formId: string;
  readonly source: 'allControls' | 'dom';
  /** 子表字段编码缺失诊断（用于排查） */
  readonly missingChildCodes?: readonly string[];
}

export type H3yunDesignerMetadataResult = H3yunDesignerMetadataSuccess | InjectionFailure;
