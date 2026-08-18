/**
 * 云枢业务规则回写（主世界注入函数）。
 *
 * 通过 chrome.scripting.executeScript({ world:'MAIN' }) 序列化到目标页面执行，
 * 因此本文件主函数所依赖的全部辅助函数都「嵌套」在主函数体内，
 * 模块顶层只允许出现 import type（编译后擦除，不参与序列化）。
 */

import type {
  BizRuleWritebackInput,
  BizRuleWritebackResult,
} from '../types/injection.js';

export function bizRuleWritebackMain(input: BizRuleWritebackInput): BizRuleWritebackResult {
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

  function createBaseResult(overrides: Record<string, unknown>): BizRuleWritebackResult {
    const base: Record<string, unknown> = {
      ok: false,
      pageUrl: safePageUrl(),
      hasMonacoGlobal: false,
      editorCount: 0,
      modelCount: 0,
      language: "",
      uri: "",
      sourceLength: 0,
      fileName: "",
      details: [] as string[],
      ...overrides
    };
    return base as unknown as BizRuleWritebackResult;
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
    const fileName = String(input?.fileName || "").trim();
    const sourceContent = String(input?.sourceContent ?? "");
    const multiModelHint = String((input as { multiModelHint?: string })?.multiModelHint || "").trim()
      || "业务规则限制：同一页面同时只支持一个业务规则编辑器，请先关闭多余业务规则后再重试。";
    if (!fileName) {
      return createBaseResult({
        errorCode: "MISSING_FILE_NAME",
        details: ["未提供待回写的业务规则文件名"]
      });
    }

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
    const details: string[] = [];
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

    const bizRuleFileNames = collectBizRuleFileNames(candidateModels);

    if (!candidateModels.length) {
      return createBaseResult({
        errorCode: "NO_MONACO_MODEL",
        hasMonacoGlobal: true,
        editorCount: editors.length,
        modelCount: models.length,
        details: ["未找到可写入的 Monaco model"]
      });
    }

    // 同页存在多个业务规则时，按文件名回写会命中错误 model，这里直接中断并提示用户排查。
    if (bizRuleFileNames.length > 1) {
      return createBaseResult({
        errorCode: "MULTIPLE_BIZRULE_MODELS",
        hasMonacoGlobal: true,
        editorCount: editors.length,
        modelCount: models.length,
        fileName,
        details: [
          `当前页面检测到多个业务规则文件：${bizRuleFileNames.join("、")}`,
          multiModelHint
        ]
      });
    }

    const matchedModel = candidateModels.find((model) => {
      const uri = model?.uri?.toString?.() || "";
      return extractFileNameFromUri(uri) === fileName;
    });

    if (!matchedModel) {
      return createBaseResult({
        errorCode: "TARGET_MODEL_NOT_FOUND",
        hasMonacoGlobal: true,
        editorCount: editors.length,
        modelCount: models.length,
        fileName,
        details: [`未找到文件名匹配 ${fileName} 的 Monaco model`]
      });
    }

    if (typeof matchedModel.setValue !== "function") {
      return createBaseResult({
        errorCode: "MODEL_NOT_WRITABLE",
        hasMonacoGlobal: true,
        editorCount: editors.length,
        modelCount: models.length,
        fileName,
        uri: matchedModel?.uri?.toString?.() || "",
        details: ["目标 Monaco model 不支持 setValue()"]
      });
    }

    matchedModel.setValue(sourceContent);
    details.push("已通过 model.setValue() 完整替换业务规则源码");

    // 说明：pageUrl/hasMonacoGlobal/editorCount/modelCount/language/uri/details
    // 为原生附带的诊断字段，超出契约 Success 形状，故在返回边界做一次断言以保留原生字段名。
    return {
      ok: true,
      pageUrl: safePageUrl(),
      hasMonacoGlobal: true,
      editorCount: editors.length,
      modelCount: models.length,
      language: typeof matchedModel.getLanguageId === "function" ? matchedModel.getLanguageId() : "",
      uri: matchedModel?.uri?.toString?.() || "",
      sourceLength: sourceContent.length,
      fileName,
      details
    } as unknown as BizRuleWritebackResult;
  } catch (error) {
    return createBaseResult({
      errorCode: "WRITEBACK_FAILED",
      fileName: String(input?.fileName || "").trim(),
      details: [error instanceof Error ? error.message : String(error)]
    });
  }
}
