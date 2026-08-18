/**
 * 氚云代码编辑器抓取（主世界注入函数）。
 *
 * 通过 chrome.scripting.executeScript({ world:'MAIN' }) 序列化到目标页面执行，
 * 因此本文件主函数所依赖的全部辅助函数都「嵌套」在主函数体内，
 * 模块顶层只允许出现 import type（编译后擦除，不参与序列化）。
 */

import type {
  H3yunCodeEditorProbeInput,
  H3yunCodeEditorProbeResult,
} from '../types/injection.js';

export function h3yunCodeEditorProbeMain(
  input: H3yunCodeEditorProbeInput,
): H3yunCodeEditorProbeResult {
  const CONTENT_SNIPPET_LENGTH = 2000;
  const LOG_HEAD_LENGTH = 60;
  const LOG_HEAD_FALLBACK_LENGTH = 100;
  const LOG_JS_HEAD_LENGTH = 80;
  const LOG_JS_TAIL_LENGTH = 40;
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
    diagnostic: string;
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

  // 氚云同页会残留模板 / 当前编辑等多个 JS model，候选评分优先"当前挂载和最近变更"，避免只按长度读到模板。
  // Monaco QuickInput（命令面板，如 Define Keybinding 视图）会创建临时 model，其内容为 UI 提示文本，
  // 常含 "/*" 等 JS 特征而被 jsPattern 误命中，需优先排除，否则会覆盖/读取错误的 model。
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

  // DOM 兜底：从 .view-lines 读取代码行，按 linenumber 排序拼接。
  // 受 Monaco 虚拟滚动限制，仅能读取当前视口 + 缓冲区内的行，大文件可能不完整。
  function readFromViewLines(container: Element): string | null {
    const viewLinesContainer = container.querySelector(".view-lines");
    if (!viewLinesContainer) {
      return null;
    }
    // 先尝试强制滚动到底部再回到顶部，触发更多行渲染
    const scrollable = container.querySelector(".monaco-scrollable-element");
    if (scrollable) {
      scrollable.scrollTop = scrollable.scrollHeight;
      scrollable.scrollTop = 0;
    }
    const lineElements = viewLinesContainer.querySelectorAll(".view-line");
    if (!lineElements.length) {
      return null;
    }
    // 按 linenumber 属性排序确保行顺序正确（虚拟滚动时 DOM 顺序可能乱）
    const lines = Array.from(lineElements)
      .sort((a, b) => (parseInt(a.getAttribute("linenumber") || "0", 10)) - (parseInt(b.getAttribute("linenumber") || "0", 10)))
      .map((el) => el.textContent || "");
    return lines.join("\n");
  }

  // 查找 Monaco model：容器 editor 匹配 → 内容特征匹配 → 唯一 model 兜底。
  // 氚云 Monaco editor 的 model 语言 ID 全部为 undefined，不可依赖语言匹配。
  function findModel(log: string[]): FindModelState {
    log.push(`[findModel] selector=${input.selector}, codeKind=${input.codeKind || "?"}`);
    const container = document.querySelector(input.selector);
    const monaco = (globalThis as { monaco?: MonacoLike }).monaco;

    if (!container) {
      log.push("[findModel] ❌ 容器未挂载");
      return { error: `页面未挂载 ${input.selector}`, diagnostic: "container-missing", container: null, editor: null, model: null, editors: [], models: [] };
    }
    log.push(`[findModel] 容器存在, 内有 .monaco-editor=${container.querySelectorAll(".monaco-editor").length}个, .view-lines=${container.querySelectorAll(".view-lines").length}个`);

    if (!monaco?.editor) {
      log.push("[findModel] ❌ window.monaco.editor 不存在");
      return { error: "window.monaco.editor 不存在", diagnostic: "monaco-missing", container, editor: null, model: null, editors: [], models: [] };
    }

    const editors = typeof monaco.editor.getEditors === "function"
      ? monaco.editor.getEditors().filter((item): item is MonacoEditorLike => Boolean(item))
      : [];
    const models = typeof monaco.editor.getModels === "function"
      ? monaco.editor.getModels().filter((item): item is MonacoModelLike => Boolean(item))
      : [];
    log.push(`[findModel] editors=${editors.length}个, models=${models.length}个`);

    // 输出每个 model 的摘要
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const lang = m?.getLanguageId?.() || "undefined";
      const len = m?.getValue?.()?.length || 0;
      const head = (m?.getValue?.() || "").substring(0, LOG_HEAD_LENGTH).replace(/\n/g, "\\n");
      log.push(`[findModel]   model[${i}]: lang=${lang}, len=${len}, head="${head}..."`);
    }

    let editor: MonacoEditorLike | null = null;
    let model: MonacoModelLike | null = null;
    // 策略1：容器 DOM 内找 editor
    editor = editors.find((item) => container.contains(item?.getDomNode?.() ?? null)) ?? null;
    model = editor?.getModel?.() ?? null;
    // 策略1b：氚云 editor 实例可能未进 monaco.editor.getEditors() 注册表（editors=0），
    // 改从每个 model 的 getAttachedEditors() 反查关联 editor，验证其 DOM 是否落在目标容器内。
    if (!model) {
      for (const m of models) {
        const attached = typeof m?.getAttachedEditors === "function" ? (m.getAttachedEditors?.() ?? []) : [];
        const hit = attached.find((item) => container.contains(item?.getDomNode?.() ?? null)) ?? null;
        if (hit) {
          editor = hit;
          model = m;
          log.push("[findModel] 策略1b: 通过 model.getAttachedEditors() 反查到容器内 editor ✓");
          break;
        }
      }
    }
    log.push(editor ? "[findModel] 策略1: 容器内找到 editor ✓" : "[findModel] 策略1: 容器内无 editor");

    // 策略2：内容特征匹配；多个 model 同时命中时按挂载状态、版本号和创建顺序评分。
    if (!model && models.length > 0) {
      if (models.length === 1) {
        model = models[0] ?? null;
        log.push("[findModel] 策略2: 唯一 model 直接取用 ✓");
      } else {
        const isFrontend = input.codeKind === "frontend";
        log.push(`[findModel] 策略2: isFrontend=${isFrontend}, 内容正则匹配 + Monaco 状态评分中...`);
        const matchedModels = models
          .map((m, index) => createModelCandidate(m, index, model))
          .filter((candidate) => {
            if (candidate.uiNoise) {
              log.push(`[findModel]   model[${candidate.index}]: 跳过(命令面板/UI 噪声), len=${candidate.length}`);
              return false;
            }
            if (isFrontend) {
              if (candidate.csHit) {
                log.push(`[findModel]   model[${candidate.index}]: 跳过(C#), len=${candidate.length}`);
                return false;
              }
              log.push(`[findModel]   model[${candidate.index}]: jsHit=${candidate.jsHit}, len=${candidate.length}, attached=${candidate.isAttached}, version=${candidate.versionId}, alt=${candidate.alternativeVersionId}`);
              return candidate.jsHit;
            }
            log.push(`[findModel]   model[${candidate.index}]: csHit=${candidate.csHit}, len=${candidate.length}, attached=${candidate.isAttached}, version=${candidate.versionId}, alt=${candidate.alternativeVersionId}`);
            return candidate.csHit;
          });
        log.push(`[findModel] 匹配到 ${matchedModels.length} 个 model`);
        // 多个命中时不再取最长：用户删除模板注释后，真实编辑内容可能比模板更短。
        if (matchedModels.length > 0) {
          const selected = matchedModels.reduce((best, current) => (compareModelCandidates(best, current) >= 0 ? best : current));
          model = selected.model;
          log.push(`[findModel] 策略2: 取评分最高 model[${selected.index}], len=${selected.length}, attached=${selected.isAttached}, version=${selected.versionId}, alt=${selected.alternativeVersionId} ✓`);
        }
      }
    }

    const diagnostic = model
      ? `found: editors=${editors.length}, models=${models.length}, codeKind=${input.codeKind || "?"}`
      : `no-model: editors=${editors.length}, models=${models.length}`;

    log.push(`[findModel] 结果: ${model ? "找到 model ✓" : "未找到 ✗"}`);

    return { container, editor, model, editors, models, diagnostic };
  }

  try {
    const log: string[] = [];
    log.push(`[h3yunProbe] 开始抓取, codeKind=${input.codeKind}, selector=${input.selector}`);
    const state = findModel(log);

    // Monaco API 路径失败时，尝试通过 .view-lines DOM 兜底读取
    if (state.error || !state.model || typeof state.model.getValue !== "function") {
      log.push("[h3yunProbe] Monaco API 路径失败，尝试 DOM 兜底...");
      const container = state.container || document.querySelector(input.selector);
      if (!container) {
        log.push("[h3yunProbe] ❌ 容器不存在");
        return { ok: false, errorCode: "H3YUN_CODE_EDITOR_NOT_FOUND", details: state.error || `页面未挂载 ${input.selector}`, debugLog: log.join("\n") };
      }
      const domContent = readFromViewLines(container);
      if (domContent === null) {
        log.push("[h3yunProbe] ❌ DOM 兜底也失败");
        const details = state.error || state.diagnostic || `${input.selector} 未找到 Monaco model 且 .view-lines DOM 也未挂载`;
        return { ok: false, errorCode: "H3YUN_CODE_EDITOR_NOT_FOUND", details, debugLog: log.join("\n") };
      }
      log.push(`[h3yunProbe] DOM 兜底成功, ${domContent.length} 字符`);
      return {
        ok: true, pageUrl: window.location.href, selector: input.selector,
        language: container.getAttribute("data-mode-id") || "", uri: "",
        sourceContent: domContent, sourceLength: domContent.length,
        editorCount: 0, modelCount: 0, readMethod: "view-lines-dom",
        diagnostic: state.diagnostic || "monaco-unavailable", debugLog: log.join("\n")
      };
    }

    // Monaco API 主路径
    const sourceContent = String(state.model.getValue() || "");
    log.push(`[h3yunProbe] Monaco API 成功, ${sourceContent.length} 字符`);
    log.push(`[h3yunProbe] 内容头部: "${sourceContent.substring(0, LOG_HEAD_FALLBACK_LENGTH).replace(/\n/g, "\\n")}"`);
    log.push(`[h3yunProbe] 内容尾部: "${sourceContent.substring(sourceContent.length - 80).replace(/\n/g, "\\n")}"`);
    // 额外输出所有匹配 JS model 的模型诊断
    for (let i = 0; i < (state.models || []).length; i++) {
      const m = state.models[i];
      const val = m?.getValue?.() || "";
      const snippet = val.substring(0, CONTENT_SNIPPET_LENGTH);
      const csHit = csPattern.test(snippet);
      const jsHit = !csHit && jsPattern.test(snippet);
      if (!csHit && jsHit) {
        log.push(`[h3yunProbe] JS model[${i}] head: "${val.substring(0, LOG_JS_HEAD_LENGTH).replace(/\n/g, "\\n")}", tail: "${val.substring(val.length - LOG_JS_TAIL_LENGTH).replace(/\n/g, "\\n")}", total=${val.length}`);
      }
    }
    return {
      ok: true, pageUrl: window.location.href, selector: input.selector,
      language: state.model.getLanguageId?.() || state.container?.getAttribute("data-mode-id") || "",
      uri: state.model.uri?.toString?.() || "",
      sourceContent, sourceLength: sourceContent.length,
      editorCount: state.editors.length, modelCount: state.models.length,
      readMethod: "monaco-api", diagnostic: state.diagnostic, debugLog: log.join("\n")
    };
  } catch (error) {
    return { ok: false, errorCode: "H3YUN_CODE_PROBE_FAILED", details: error instanceof Error ? error.message : String(error) };
  }
}
