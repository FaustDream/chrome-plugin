/**
 * 云枢业务规则抓取（主世界注入函数）。
 *
 * 通过 chrome.scripting.executeScript({ world:'MAIN' }) 序列化到目标页面执行，
 * 因此本文件主函数所依赖的全部辅助函数都「嵌套」在主函数体内，
 * 模块顶层只允许出现 import type（编译后擦除，不参与序列化）。
 */

import type {
  BizRuleProbeInput,
  BizRuleProbeResult,
} from '../types/injection.js';

export function bizRuleProbeMain(input: BizRuleProbeInput): BizRuleProbeResult {
  const JAVA_SNIPPET_SAMPLE_LENGTH = 300;
  // ── 局部类型：描述主世界里的 Monaco 结构（避免隐式 any） ──────────
  interface MonacoModelLike {
    getValue?: () => string;
    setValue?: (value: string) => void;
    getLanguageId?: () => string;
    uri?: { toString?: () => string };
  }
  interface MonacoEditorLike {
    getModel?: () => MonacoModelLike | null | undefined;
  }
  interface MonacoLike {
    editor?: {
      getEditors?: () => (MonacoEditorLike | null | undefined)[];
      getModels?: () => (MonacoModelLike | null | undefined)[];
    };
  }

  function safePageUrl(): string {
    try {
      return window.location.href;
    } catch (_error) {
      return "";
    }
  }

  function createBaseResult(overrides: Record<string, unknown>): BizRuleProbeResult {
    const base: Record<string, unknown> = {
      ok: false,
      pageUrl: safePageUrl(),
      hasMonacoGlobal: false,
      editorCount: 0,
      modelCount: 0,
      language: "",
      uri: "",
      sourceLength: 0,
      sourceContent: "",
      className: "",
      fileName: "",
      sampleText: "",
      details: [] as string[],
      ...overrides
    };
    return base as unknown as BizRuleProbeResult;
  }

  function extractFileNameFromUri(uri: unknown): string {
    const normalized = String(uri || "").trim();
    if (!normalized) {
      return "";
    }

    const match = normalized.match(/\/([^/?#]+\.java)(?:[?#].*)?$/i);
    return match && match[1] ? match[1] : "";
  }

  function extractJavaClassName(source: unknown): string {
    const text = String(source || "");
    const publicMatch = text.match(/\bpublic\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (publicMatch && publicMatch[1]) {
      return publicMatch[1];
    }

    const classMatch = text.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    return classMatch && classMatch[1] ? classMatch[1] : "";
  }

  function collectCandidateModels(editors: MonacoEditorLike[], models: MonacoModelLike[]): MonacoModelLike[] {
    const candidateModels: MonacoModelLike[] = [];
    const seenModels = new Set<MonacoModelLike>();

    for (const editor of editors) {
      const model = typeof editor?.getModel === "function" ? editor.getModel() : null;
      if (model && !seenModels.has(model)) {
        candidateModels.push(model);
        seenModels.add(model);
      }
    }

    for (const model of models) {
      if (model && !seenModels.has(model)) {
        candidateModels.push(model);
        seenModels.add(model);
      }
    }

    return candidateModels;
  }

  function collectBizRuleFileNames(candidateModels: MonacoModelLike[]): string[] {
    const fileNames: string[] = [];
    const seenFileNames = new Set<string>();

    for (const model of candidateModels) {
      const uriFileName = extractFileNameFromUri(model?.uri?.toString?.() || "");
      const language = typeof model?.getLanguageId === "function" ? model.getLanguageId() : "";
      if (!uriFileName && language !== "java") {
        continue;
      }

      const source = typeof model?.getValue === "function" ? String(model.getValue() || "") : "";
      const className = extractJavaClassName(source);
      const fileName = uriFileName || (className ? `${className}.java` : "");
      if (fileName && !seenFileNames.has(fileName)) {
        fileNames.push(fileName);
        seenFileNames.add(fileName);
      }
    }

    return fileNames;
  }

  try {
    const multiModelHint = String((input as { multiModelHint?: string })?.multiModelHint || "").trim()
      || "业务规则限制：同一页面同时只支持一个业务规则编辑器，请先关闭多余业务规则后再重试。";
    const monaco = (globalThis as { monaco?: MonacoLike }).monaco;
    if (!monaco?.editor) {
      return createBaseResult({
        errorCode: "NO_MONACO_GLOBAL",
        details: ["window.monaco.editor 不存在"]
      });
    }

    const editors = typeof monaco.editor.getEditors === "function"
      ? monaco.editor.getEditors().filter((editor): editor is MonacoEditorLike => Boolean(editor))
      : [];
    const models = typeof monaco.editor.getModels === "function"
      ? monaco.editor.getModels().filter((model): model is MonacoModelLike => Boolean(model))
      : [];
    const candidateModels = collectCandidateModels(editors, models);
    const details: string[] = [];
    const bizRuleFileNames = collectBizRuleFileNames(candidateModels);
    const model = candidateModels.find((candidateModel) => {
      const uriFileName = extractFileNameFromUri(candidateModel?.uri?.toString?.() || "");
      const language = typeof candidateModel?.getLanguageId === "function"
        ? candidateModel.getLanguageId()
        : "";
      return Boolean(uriFileName) || language === "java";
    }) || candidateModels[0] || null;

    // 业务规则回写依赖页面内只存在一个有效 Java model，多开时必须先阻止继续抓取。
    if (bizRuleFileNames.length > 1) {
      return createBaseResult({
        errorCode: "MULTIPLE_BIZRULE_MODELS",
        hasMonacoGlobal: true,
        editorCount: editors.length,
        modelCount: models.length,
        details: [
          `当前页面检测到多个业务规则文件：${bizRuleFileNames.join("、")}`,
          multiModelHint
        ]
      });
    }

    if (!model) {
      return createBaseResult({
        errorCode: "NO_MONACO_MODEL",
        hasMonacoGlobal: true,
        editorCount: editors.length,
        modelCount: models.length,
        details: details.concat("未找到可用的 Monaco model")
      });
    }

    details.push("已收集到当前页面候选 Monaco model");

    if (typeof model.getValue !== "function") {
      return createBaseResult({
        errorCode: "MODEL_NOT_READABLE",
        hasMonacoGlobal: true,
        editorCount: editors.length,
        modelCount: models.length,
        details: details.concat("Monaco model 不支持getValue()")
      });
    }

    const source = String(model.getValue() || "");
    const sampleText = source.slice(0, JAVA_SNIPPET_SAMPLE_LENGTH);
    const language = typeof model.getLanguageId === "function" ? model.getLanguageId() : "";
    const uri = model.uri?.toString?.() || "";
    const className = extractJavaClassName(source);
    const uriFileName = extractFileNameFromUri(uri);
    const fileName = uriFileName || (className ? `${className}.java` : "");
    details.push(source ? "已读取到源代码文本" : "源代码文本为空");
    if (uriFileName) {
      details.push("已从 model URI 解析文件名");
    } else if (className) {
      details.push("已从源代码类名回退解析文件名");
    } else {
      details.push("未解析到业务规则文件名");
    }

    // 说明：pageUrl/hasMonacoGlobal/editorCount/modelCount/sourceLength/sampleText/details
    // 为原生附带的诊断字段，超出契约 Success 形状，故在返回边界做一次断言以保留原生字段名。
    return {
      ok: true,
      pageUrl: safePageUrl(),
      hasMonacoGlobal: true,
      editorCount: editors.length,
      modelCount: models.length,
      language,
      uri,
      sourceLength: source.length,
      sourceContent: source,
      className,
      fileName,
      sampleText,
      details
    } as BizRuleProbeResult;
  } catch (error) {
    return createBaseResult({
      errorCode: "MONACO_PROBE_FAILED",
      details: [error instanceof Error ? error.message : String(error)]
    });
  }
}
