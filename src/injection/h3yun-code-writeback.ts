/**
 * 氚云代码编辑器回写（主世界注入函数）。
 *
 * 通过 chrome.scripting.executeScript({ world:'MAIN' }) 序列化到目标页面执行，
 * 因此本文件主函数所依赖的全部辅助函数都「嵌套」在主函数体内，
 * 模块顶层只允许出现 import type（编译后擦除，不参与序列化）。
 */

import type {
  H3yunCodeEditorWritebackInput,
  H3yunCodeEditorWritebackResult,
} from '../types/injection.js';

export function h3yunCodeEditorWritebackMain(
  input: H3yunCodeEditorWritebackInput,
): H3yunCodeEditorWritebackResult {
  const CONTENT_SNIPPET_LENGTH = 2000;
  // ── 局部类型：描述主世界里的 Monaco 结构（避免隐式 any） ──────────
  interface MonacoModelLike {
    getValue?: () => string;
    setValue?: (value: string) => void;
    getLanguageId?: () => string;
    isAttachedToEditor?: () => boolean;
    getAttachedEditors?: () => (MonacoEditorLike | null | undefined)[];
    getVersionId?: () => number;
    getAlternativeVersionId?: () => number;
    uri?: { toString?: () => string };
  }
  interface MonacoEditorLike {
    getModel?: () => MonacoModelLike | null | undefined;
    getDomNode?: () => Node | null | undefined;
  }
  interface MonacoLike {
    editor?: {
      getEditors?: () => (MonacoEditorLike | null | undefined)[];
      getModels?: () => (MonacoModelLike | null | undefined)[];
    };
  }
  interface ModelCandidate {
    model: MonacoModelLike;
    index: number;
    csHit: boolean;
    jsHit: boolean;
    uiNoise: boolean;
    length: number;
    isContainerModel: number;
    isAttached: number;
    versionId: number;
    alternativeVersionId: number;
  }
  interface FindModelState {
    error?: string;
    container: Element | null;
    editor: MonacoEditorLike | null;
    model: MonacoModelLike | null;
    editors: MonacoEditorLike[];
    models: MonacoModelLike[];
  }

  const csPattern = /using\s+System|namespace\s+\w+|public\s+class\s+\w+|H3\.SmartForm/;
  const jsPattern = /\/\*|\$\..*extend|function\s*\(|控件接口/;

  function safeNumber(value: unknown, fallback = 0): number {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  }

  // 候选评分：优先当前挂载、版本更新、创建更早的 model，避免在多 model 时误选模板。
  function compareModelCandidates(left: ModelCandidate, right: ModelCandidate): number {
    const priorityKeys = ["isContainerModel", "isAttached", "versionId", "alternativeVersionId", "index", "length"];
    for (const key of priorityKeys) {
      const fallback = key === "index" ? -1 : 0;
      const leftValue = safeNumber((left as unknown as Record<string, unknown>)[key], fallback);
      const rightValue = safeNumber((right as unknown as Record<string, unknown>)[key], fallback);
      if (leftValue !== rightValue) {
        return leftValue - rightValue;
      }
    }
    return 0;
  }

  // 基于内容特征和 Monaco 状态构建候选评分对象
  // Monaco QuickInput（命令面板，如 Define Keybinding 视图）会创建临时 model，其内容为 UI 提示文本，
  // 常含 "/*" 等 JS 特征而被 jsPattern 误命中，需优先排除，否则回写会覆盖错误的 model。
  function isUiNoiseModel(model: MonacoModelLike): boolean {
    const text = String(model?.getValue?.() || "");
    return (
      text.includes("Define Keybinding") ||
      text.includes("Press desired key combination and ENTER") ||
      text.includes("No results")
    );
  }

  function createModelCandidate(
    model: MonacoModelLike,
    index: number,
    containerModel: MonacoModelLike | null,
  ): ModelCandidate {
    const sourceContent = String(model?.getValue?.() || "");
    const snippet = sourceContent.substring(0, CONTENT_SNIPPET_LENGTH);
    const csHit = csPattern.test(snippet);
    const jsHit = !csHit && jsPattern.test(snippet);
    return {
      model,
      index,
      csHit,
      jsHit,
      uiNoise: isUiNoiseModel(model),
      length: sourceContent.length,
      isContainerModel: model === containerModel ? 1 : 0,
      isAttached: typeof model.isAttachedToEditor === "function" && model.isAttachedToEditor() ? 1 : 0,
      versionId: safeNumber(model?.getVersionId?.()),
      alternativeVersionId: safeNumber(model?.getAlternativeVersionId?.())
    };
  }

  // 查找 Monaco model：容器 editor 匹配 → 内容特征匹配 → 唯一 model 兜底。
  function findModel(log: string[]): FindModelState {
    log.push(`[writeback] selector=${input.selector}, codeKind=${input.codeKind || "?"}`);
    const container = document.querySelector(input.selector);
    const monaco = (globalThis as { monaco?: MonacoLike }).monaco;
    if (!container || !monaco?.editor) {
      log.push(`[writeback] ❌ ${!container ? "容器未挂载" : "monaco.editor 不存在"}`);
      return {
        error: !container ? `页面未挂载 ${input.selector}` : "window.monaco.editor 不存在",
        container: container ?? null,
        editor: null,
        model: null,
        editors: [],
        models: []
      };
    }
    const editors = typeof monaco.editor.getEditors === "function"
      ? monaco.editor.getEditors().filter((item): item is MonacoEditorLike => Boolean(item))
      : [];
    const models = typeof monaco.editor.getModels === "function"
      ? monaco.editor.getModels().filter((item): item is MonacoModelLike => Boolean(item))
      : [];
    log.push(`[writeback] editors=${editors.length}, models=${models.length}`);
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      log.push(`[writeback]   model[${i}]: lang=${m?.getLanguageId?.() || "undefined"}, len=${m?.getValue?.()?.length || 0}`);
    }
    // 策略1：容器 DOM 内找 editor
    let containerEditor = editors.find((item) => container.contains(item?.getDomNode?.() ?? null)) ?? null;
    let model: MonacoModelLike | null = containerEditor?.getModel?.() ?? null;
    // 策略1b：氚云 editor 实例可能未进 monaco.editor.getEditors() 注册表（editors=0），
    // 改从每个 model 的 getAttachedEditors() 反查关联 editor，验证其 DOM 是否落在目标容器内。
    if (!model) {
      for (const m of models) {
        const attached = typeof m?.getAttachedEditors === "function" ? (m.getAttachedEditors?.() ?? []) : [];
        const hit = attached.find((item) => container.contains(item?.getDomNode?.() ?? null)) ?? null;
        if (hit) {
          containerEditor = hit;
          model = m;
          log.push("[writeback] 策略1b: 通过 model.getAttachedEditors() 反查到容器内 editor ✓");
          break;
        }
      }
    }
    log.push(containerEditor ? "[writeback] 策略1: 容器内找到 editor ✓" : "[writeback] 策略1: 容器内无 editor");
    // 策略2：内容特征匹配；多个 model 同时命中时按挂载状态、版本号和创建顺序评分。
    if (!model && models.length > 0) {
      if (models.length === 1) {
        model = models[0] ?? null;
        log.push("[writeback] 策略2: 唯一 model 直接取用 ✓");
      } else {
        const isFrontend = input.codeKind === "frontend";
        log.push(`[writeback] 策略2: isFrontend=${isFrontend}, 内容正则匹配 + Monaco 状态评分中...`);
        const matchedModels = models
          .map((m, index) => createModelCandidate(m, index, model))
          .filter((candidate) => {
            if (candidate.uiNoise) { log.push(`[writeback]   model[${candidate.index}]: 跳过(命令面板/UI 噪声), len=${candidate.length}`); return false; }
            if (isFrontend) {
              if (candidate.csHit) { log.push(`[writeback]   model[${candidate.index}]: 跳过(C#), len=${candidate.length}`); return false; }
              log.push(`[writeback]   model[${candidate.index}]: jsHit=${candidate.jsHit}, len=${candidate.length}, attached=${candidate.isAttached}, version=${candidate.versionId}, alt=${candidate.alternativeVersionId}`);
              return candidate.jsHit;
            }
            log.push(`[writeback]   model[${candidate.index}]: csHit=${candidate.csHit}, len=${candidate.length}, attached=${candidate.isAttached}, version=${candidate.versionId}, alt=${candidate.alternativeVersionId}`);
            return candidate.csHit;
          });
        log.push(`[writeback] 匹配到 ${matchedModels.length} 个 model`);
        if (matchedModels.length > 0) {
          const selected = matchedModels.reduce((best, current) => (compareModelCandidates(best, current) >= 0 ? best : current));
          model = selected.model;
          log.push(`[writeback] 策略2: 取评分最高 model[${selected.index}], len=${selected.length}, attached=${selected.isAttached}, version=${selected.versionId} ✓`);
        }
      }
    }
    log.push(`[writeback] 结果: ${model ? "找到 model ✓" : "未找到 ✗"}`);
    return { container, editor: containerEditor, model, editors, models };
  }

  try {
    const log: string[] = [];
    log.push(`[writeback] 开始, codeKind=${input.codeKind}, sourceLength=${(input.sourceContent || "").length}`);
    const state = findModel(log);
    if (state.error) {
      return { ok: false, errorCode: "H3YUN_CODE_EDITOR_NOT_FOUND", details: state.error, debugLog: log.join("\n") };
    }

    // 回写目标 model：直接使用 findModel 精确定位的激活 model，不向全部 model 广播写入，
    // 避免覆盖后台隐藏标签页的 model 导致平台状态冲突或编辑器变只读。
    const targetModel = state.model;
    if (!targetModel || typeof targetModel.setValue !== "function") {
      log.push("[writeback] ❌ findModel 未返回可写 model");
      return { ok: false, errorCode: "H3YUN_CODE_MODEL_NOT_WRITABLE", details: `${input.selector} 未找到可写 Monaco model`, debugLog: log.join("\n") };
    }

    const sourceContent = String(input.sourceContent ?? "");
    targetModel.setValue(sourceContent);
    log.push(`[writeback] 成功, 写入 model`);
    // 说明：language/editorCount/modelCount 为原生附带的诊断字段，超出契约 Success 形状，
    // 故在返回边界做一次断言以保留原生字段名。
    return {
      ok: true, pageUrl: window.location.href, selector: input.selector,
      language: targetModel.getLanguageId?.() || state.container?.getAttribute("data-mode-id") || "",
      sourceLength: sourceContent.length,
      editorCount: state.editors.length, modelCount: state.models.length,
      writableCount: 1, debugLog: log.join("\n")
    } as H3yunCodeEditorWritebackResult;
  } catch (error) {
    return { ok: false, errorCode: "H3YUN_CODE_WRITEBACK_FAILED", details: error instanceof Error ? error.message : String(error) };
  }
}
