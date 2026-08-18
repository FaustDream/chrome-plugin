/**
 * 云枢前端抓取（主世界注入函数）。
 *
 * 通过 chrome.scripting.executeScript({ world:'MAIN' }) 序列化到目标页面执行，
 * 因此本文件主函数所依赖的全部辅助函数都「嵌套」在主函数体内，
 * 模块顶层只允许出现 import type（编译后擦除，不参与序列化）。
 */

import type {
  PageCaptureInput,
  PageCaptureResult,
} from '../types/injection.js';

export function pageCaptureMain(input: PageCaptureInput): PageCaptureResult {
  // ── 局部类型：描述主世界里的 Vue2 / Vue3 组件结构（避免隐式 any） ──
  interface Vue2Instance {
    $options?: { name?: string; _componentTag?: string };
    $vnode?: { componentOptions?: { Ctor?: { options?: { name?: string } } } };
    $data?: Record<string, unknown>;
    $el?: Node | null;
    $children?: Vue2Instance[];
    [key: string]: unknown;
  }
  interface Vue3Instance {
    type?: { name?: string; __name?: string };
    proxy?: { $options?: { name?: string }; $data?: Record<string, unknown>; [key: string]: unknown };
    vnode?: { el?: Node | null };
    subTree?: { component?: Vue3Instance; children?: unknown };
    component?: Vue3Instance;
    [key: string]: unknown;
  }
  type VueElement = Element & {
    __vue__?: Vue2Instance;
    __vueParentComponent?: Vue3Instance;
    __vue_app__?: { _instance?: Vue3Instance };
  };
  interface VisibleScore {
    visible: boolean;
    area: number;
    distance: number;
  }
  interface ScoredCandidate {
    vueMajor: number;
    instance: Vue2Instance | Vue3Instance;
    componentName: string;
    data: Record<string, unknown> | undefined;
    element: Element | null;
    score: VisibleScore;
  }
  interface ControlRecord {
    code: string;
    name: string;
  }
  interface SubtableRecord {
    code: string;
    name: string;
    controls: ControlRecord[];
  }

  // ── 局部常量（executeScript 序列化约束：不能引用文件外层常量）──
  const DEFAULT_CANDIDATE_NAMES = ["editor"];
  const SANITIZE_MAX_DEPTH = 12;
  const TRAVERSE_MAX_DEPTH = 10;

  const rawNames = input?.candidateComponentNames;
  const candidateNames: string[] = Array.isArray(rawNames)
    ? rawNames.filter((name): name is string => Boolean(name))
    : DEFAULT_CANDIDATE_NAMES;

  function safePageUrl(): string {
    try {
      return window.location.href;
    } catch (_error) {
      return "";
    }
  }

  function createBaseResult(overrides: Record<string, unknown>): PageCaptureResult {
    const base: Record<string, unknown> = {
      ok: false,
      pageUrl: safePageUrl(),
      candidateCount: 0,
      discoveredComponentNames: [] as string[],
      ...overrides
    };
    return base as unknown as PageCaptureResult;
  }

  function nodeVisibleScore(element: Element | null): VisibleScore {
    if (!(element instanceof Element)) {
      return { visible: false, area: 0, distance: Number.MAX_SAFE_INTEGER };
    }

    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const overlapWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    const overlapHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
    const area = overlapWidth * overlapHeight;
    const visible = area > 0;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = Math.abs(centerX - viewportWidth / 2) + Math.abs(centerY - viewportHeight / 2);
    return { visible, area, distance };
  }

  function sanitizeValue(value: unknown, seen: WeakMap<object, string> = new WeakMap(), depth = 0): unknown {
    if (depth > SANITIZE_MAX_DEPTH) {
      return "[MaxDepthExceeded]";
    }

    if (value === null) {
      return null;
    }

    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
      return value;
    }
    if (valueType === "undefined") {
      return "[undefined]";
    }
    if (valueType === "bigint") {
      return `${(value as bigint).toString()}n`;
    }
    if (valueType === "function") {
      return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
    }
    if (valueType === "symbol") {
      return (value as symbol).toString();
    }

    // 经过上面的原始类型分支后，value 必为非 null 对象
    const objValue = value as object;
    if (objValue instanceof Date) {
      return Number.isNaN(objValue.getTime()) ? "[Invalid Date]" : objValue.toISOString();
    }
    if (objValue instanceof RegExp) {
      return objValue.toString();
    }
    if (objValue instanceof Error) {
      return {
        name: objValue.name,
        message: objValue.message,
        stack: objValue.stack || ""
      };
    }
    if (objValue instanceof Node) {
      return `[DOMNode ${objValue.nodeName}]`;
    }
    if (seen.has(objValue)) {
      return `[Circular -> ${seen.get(objValue)}]`;
    }
    if (Array.isArray(objValue)) {
      seen.set(objValue, `array@${depth}`);
      return (objValue as unknown[]).map((item) => sanitizeValue(item, seen, depth + 1));
    }

    const proto = Object.getPrototypeOf(objValue);
    if (proto !== Object.prototype && proto !== null) {
      const name = (objValue as { constructor?: { name?: string } }).constructor?.name || "Object";
      seen.set(objValue, `${name}@${depth}`);
      const plainCopy: Record<string, unknown> = {};
      for (const key of Object.keys(objValue)) {
        plainCopy[key] = sanitizeValue((objValue as Record<string, unknown>)[key], seen, depth + 1);
      }
      plainCopy.__type = name;
      return plainCopy;
    }

    seen.set(objValue, `object@${depth}`);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(objValue)) {
      result[key] = sanitizeValue((objValue as Record<string, unknown>)[key], seen, depth + 1);
    }
    return result;
  }

  function getVue2Name(vm: Vue2Instance | null | undefined): string {
    return (
      vm?.$options?.name ||
      vm?.$options?._componentTag ||
      vm?.$vnode?.componentOptions?.Ctor?.options?.name ||
      ""
    );
  }

  function getVue3Name(instance: Vue3Instance | null | undefined): string {
    return instance?.type?.name || instance?.type?.__name || instance?.proxy?.$options?.name || "";
  }

  function getVue2Data(vm: Vue2Instance | null | undefined): Record<string, unknown> | undefined {
    return vm?.$data;
  }

  function getVue3Data(instance: Vue3Instance | null | undefined): Record<string, unknown> | undefined {
    return instance?.proxy?.$data;
  }

  const discoveredComponentNames = new Set<string>();
  const candidateEntries: ScoredCandidate[] = [];
  const visitedInstances = new WeakSet<object>();
  let vueMajor: number | undefined;

  function addCandidate(entry: Omit<ScoredCandidate, "score">): void {
    if (!entry.instance || visitedInstances.has(entry.instance)) {
      return;
    }

    visitedInstances.add(entry.instance);
    if (entry.componentName) {
      discoveredComponentNames.add(entry.componentName);
    }

    if (!candidateNames.includes(entry.componentName)) {
      return;
    }

    candidateEntries.push({
      ...entry,
      score: nodeVisibleScore(entry.element)
    });
  }

  function scanElements(): void {
    const walker = document.createTreeWalker(
      document.documentElement || document.body,
      NodeFilter.SHOW_ELEMENT
    );
    let currentNode: Node | null = walker.currentNode;

    while (currentNode) {
      const node = currentNode as VueElement;
      if (node.__vue__) {
        vueMajor = vueMajor || 2;
        addCandidate({
          vueMajor: 2,
          instance: node.__vue__,
          componentName: getVue2Name(node.__vue__),
          data: getVue2Data(node.__vue__),
          element: node
        });
      }

      if (node.__vueParentComponent) {
        vueMajor = vueMajor || 3;
        addCandidate({
          vueMajor: 3,
          instance: node.__vueParentComponent,
          componentName: getVue3Name(node.__vueParentComponent),
          data: getVue3Data(node.__vueParentComponent),
          element: node
        });
      }

      currentNode = walker.nextNode();
    }
  }

  function walkVue3Tree(instance: Vue3Instance | null | undefined, hostElement: Element | null, nestedVisited: WeakSet<object>): void {
    if (!instance || nestedVisited.has(instance)) {
      return;
    }

    nestedVisited.add(instance);
    vueMajor = vueMajor || 3;

    const vnodeEl: Node | null = instance.vnode?.el ?? null;
    const element = vnodeEl instanceof Element ? vnodeEl : hostElement;
    addCandidate({
      vueMajor: 3,
      instance,
      componentName: getVue3Name(instance),
      data: getVue3Data(instance),
      element
    });

    const subTreeChildren: Vue3Instance[] = [];
    const subTree = instance.subTree;
    if (subTree?.component) {
      subTreeChildren.push(subTree.component);
    }
    const subTreeKids = subTree?.children;
    if (Array.isArray(subTreeKids)) {
      for (const child of subTreeKids as unknown[]) {
        const comp = (child as { component?: Vue3Instance } | null)?.component;
        if (comp) {
          subTreeChildren.push(comp);
        }
      }
    }
    if (instance.component) {
      subTreeChildren.push(instance.component);
    }

    for (const childInstance of subTreeChildren) {
      walkVue3Tree(childInstance, element, nestedVisited);
    }
  }

  function walkVue2Tree(vm: Vue2Instance | null | undefined, nestedVisited: WeakSet<object>): void {
    if (!vm || nestedVisited.has(vm)) {
      return;
    }

    nestedVisited.add(vm);
    vueMajor = vueMajor || 2;

    const vmEl: Node | null = vm.$el ?? null;
    addCandidate({
      vueMajor: 2,
      instance: vm,
      componentName: getVue2Name(vm),
      data: getVue2Data(vm),
      element: vmEl instanceof Element ? vmEl : null
    });

    if (Array.isArray(vm.$children)) {
      for (const child of vm.$children) {
        walkVue2Tree(child, nestedVisited);
      }
    }
  }

  function scanVueRoots(): void {
    const vue3Visited = new WeakSet<object>();
    const vue2Visited = new WeakSet<object>();

    const allElements = document.querySelectorAll("*");
    for (const element of allElements) {
      const el = element as VueElement;
      if (el.__vue_app__?._instance) {
        walkVue3Tree(el.__vue_app__._instance, el, vue3Visited);
      }
      if (el.__vue__) {
        walkVue2Tree(el.__vue__, vue2Visited);
      }
    }
  }

  function firstReadableText(values: unknown[]): string {
    for (const value of values) {
      const cleaned = String(value || "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned) {
        return cleaned;
      }
    }
    return "";
  }

  function splitChineseNames(rawText: unknown): { applicationName: string; formName: string } {
    const text = firstReadableText([rawText]);
    if (!text) {
      return { applicationName: "", formName: "" };
    }

    const normalized = text
      .replace(/[>：]/g, "/")
      .replace(/[|~]/g, "/")
      .replace(/\s+-\s+/g, "/");
    const parts = normalized
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      return {
        applicationName: parts[0] ?? "",
        formName: parts[1] ?? ""
      };
    }

    return {
      applicationName: parts[0] || "",
      formName: parts[0] || ""
    };
  }

  function extractModelCodes(href: string): { applicationCode: string; formCode: string } {
    const fallback = { applicationCode: "", formCode: "" };
    if (!href) {
      return fallback;
    }

    // 与 lib/platform/readme-parser.ts 的 parseModelCodesFromPageUrl 保持一致（镜像实现，修改需同步）。
    // 非法 percent 序列会抛 URIError，解析失败时按原始字符串继续。
    let decodedHref = href;
    try {
      decodedHref = decodeURIComponent(href);
    } catch (_error) {
      // 保持原始字符串参与后续拆分
    }
    try {
      const url = new URL(decodedHref, window.location.href);
      const modelParam = url.searchParams.get("model");
      if (modelParam) {
        const parts = modelParam
          .split(/[/?#&=]/)
          .map((item) => item.trim())
          .filter(Boolean);
        if (parts.length >= 2) {
          return {
            applicationCode: parts[0] ?? "",
            formCode: parts[1] ?? ""
          };
        }
      }
    } catch (_error) {
      // Continue with token scan.
    }

    const tokens = decodedHref
      .split(/[/?#&=]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const modelIndex = tokens.findIndex((token) => token.toLowerCase() === "model");
    if (modelIndex >= 0) {
      return {
        applicationCode: tokens[modelIndex + 1] || "",
        formCode: tokens[modelIndex + 2] || ""
      };
    }

    return fallback;
  }

  function extractLinkMetadata(): {
    href: string;
    linkText: string;
    applicationCode: string;
    formCode: string;
    applicationName: string;
    formName: string;
  }[] {
    const seenLinks = new Set<string>();
    const linkRecords: {
      href: string;
      linkText: string;
      applicationCode: string;
      formCode: string;
      applicationName: string;
      formName: string;
    }[] = [];
    for (const raw of document.querySelectorAll("a[href]")) {
      const anchor = raw as HTMLAnchorElement;
      const href = firstReadableText([anchor.href, anchor.getAttribute("href")]);
      if (!href || seenLinks.has(href)) {
        continue;
      }
      seenLinks.add(href);

      const labelText = firstReadableText([
        anchor.textContent,
        anchor.title,
        anchor.getAttribute("aria-label")
      ]);
      const names = splitChineseNames(labelText);
      const codes = extractModelCodes(href);
      linkRecords.push({
        href,
        linkText: labelText,
        applicationCode: codes.applicationCode,
        formCode: codes.formCode,
        applicationName: names.applicationName,
        formName: names.formName
      });
    }
    return linkRecords;
  }

  function findFormName(): string {
    const selectorCandidates = [
      "[data-form-name]",
      ".form-title",
      ".sheet-title",
      ".header-title",
      ".title",
      "h1"
    ];

    for (const selector of selectorCandidates) {
      const element = document.querySelector(selector) as HTMLElement | null;
      const text = firstReadableText([
        element?.getAttribute?.("data-form-name"),
        element?.textContent,
        element?.title
      ]);
      if (text) {
        return text;
      }
    }

    return firstReadableText([document.title]);
  }

  function findCodeFromElement(element: Element): string {
    const codeAttributeNames = [
      "data-code",
      "code",
      "data-control-code",
      "data-field-code",
      "field-code",
      "data-schema-code",
      "schema-code",
      "data-bizpropertycode",
      "bizpropertycode"
    ];

    const code = firstReadableText(
      codeAttributeNames.map((name) => element.getAttribute?.(name))
    );
    if (!code) {
      return "";
    }
    return /^[A-Za-z0-9_-]{2,}$/.test(code) ? code : "";
  }

  function findNameFromElement(element: Element): string {
    return firstReadableText([
      element.getAttribute?.("data-name"),
      element.getAttribute?.("label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
      element.textContent
    ]);
  }

  function looksLikeSubtableContainer(element: Element): boolean {
    const source = [
      element.id,
      element.className,
      element.getAttribute?.("data-name"),
      element.getAttribute?.("data-code"),
      element.getAttribute?.("title")
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");

    return /subtable|sub-table|detail|child|sheet|鏄庣粏|瀛愯〃/.test(source);
  }

  function extractControlsFromDom(): { mainControls: ControlRecord[]; subtables: SubtableRecord[] } {
    const mainControls: ControlRecord[] = [];
    const subtablesMap = new Map<string, SubtableRecord>();
    const seenControls = new Set<string>();
    const elements = document.querySelectorAll("*");

    for (const element of elements) {
      const code = findCodeFromElement(element);
      if (!code) {
        continue;
      }

      const name = findNameFromElement(element);
      const subtableContainer = element.closest("*");
      let ownerTable: Element | null = null;

      let currentParent = element.parentElement;
      while (currentParent) {
        if (looksLikeSubtableContainer(currentParent)) {
          ownerTable = currentParent;
          break;
        }
        currentParent = currentParent.parentElement;
      }

      if (ownerTable) {
        const tableCode = findCodeFromElement(ownerTable) || firstReadableText([ownerTable.id]);
        const tableName = findNameFromElement(ownerTable) || tableCode;
        if (!tableCode) {
          continue;
        }
        const tableKey = `${tableCode}|${tableName}`;
        if (!subtablesMap.has(tableKey)) {
          subtablesMap.set(tableKey, {
            code: tableCode,
            name: tableName,
            controls: []
          });
        }
        const controlKey = `sub:${tableCode}:${code}:${name}`;
        if (!seenControls.has(controlKey)) {
          seenControls.add(controlKey);
          const table = subtablesMap.get(tableKey);
          if (table) {
            table.controls.push({ code, name });
          }
        }
        continue;
      }

      const controlKey = `main:${code}:${name}`;
      if (seenControls.has(controlKey)) {
        continue;
      }
      seenControls.add(controlKey);
      mainControls.push({ code, name });
      void subtableContainer;
    }

    return {
      mainControls,
      subtables: Array.from(subtablesMap.values())
    };
  }

  function extractControlsFromData(rawData: unknown): { mainControls: ControlRecord[]; subtables: SubtableRecord[] } {
    const mainControls: ControlRecord[] = [];
    const subtablesMap = new Map<string, SubtableRecord>();
    const seen = new WeakSet<object>();
    const controlKeys = new Set<string>();

    function getCode(candidate: unknown): string {
      if (!candidate || typeof candidate !== "object") {
        return "";
      }
      const rec = candidate as Record<string, unknown>;
      return firstReadableText([
        rec.code,
        rec.schemaCode,
        rec.fieldCode,
        rec.bizPropertyCode,
        rec.propertyCode
      ]);
    }

    function getName(candidate: unknown): string {
      if (!candidate || typeof candidate !== "object") {
        return "";
      }
      const rec = candidate as Record<string, unknown>;
      return firstReadableText([
        rec.name,
        rec.label,
        rec.title,
        rec.text,
        rec.displayName,
        rec.chName
      ]);
    }

    function looksLikeSubtable(candidate: unknown): boolean {
      const rec = (candidate && typeof candidate === "object" ? candidate : {}) as Record<string, unknown>;
      const marker = firstReadableText([
        rec.type,
        rec.componentType,
        rec.widgetType,
        rec.controlType,
        rec.name,
        rec.label
      ]).toLowerCase();
      return /subtable|detail|child|sheet|鏄庣粏|瀛愯〃/.test(marker);
    }

    function walk(node: unknown, currentSubtable: ControlRecord | null = null, depth = 0): void {
      if (!node || typeof node !== "object" || depth > TRAVERSE_MAX_DEPTH) {
        return;
      }
      if (seen.has(node)) {
        return;
      }
      seen.add(node);

      const nextSubtable: ControlRecord | null =
        looksLikeSubtable(node) && getCode(node)
          ? {
              code: getCode(node),
              name: getName(node) || getCode(node)
            }
          : currentSubtable;

      const code = getCode(node);
      const name = getName(node);
      if (code && name) {
        if (nextSubtable && nextSubtable.code === code) {
          // Skip the container itself.
        } else if (nextSubtable) {
          if (!subtablesMap.has(nextSubtable.code)) {
            subtablesMap.set(nextSubtable.code, {
              code: nextSubtable.code,
              name: nextSubtable.name,
              controls: []
            });
          }
          const key = `sub:${nextSubtable.code}:${code}:${name}`;
          if (!controlKeys.has(key)) {
            controlKeys.add(key);
            const table = subtablesMap.get(nextSubtable.code);
            if (table) {
              table.controls.push({ code, name });
            }
          }
        } else {
          const key = `main:${code}:${name}`;
          if (!controlKeys.has(key)) {
            controlKeys.add(key);
            mainControls.push({ code, name });
          }
        }
      }

      for (const value of Object.values(node as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const item of value as unknown[]) {
            walk(item, nextSubtable, depth + 1);
          }
        } else if (value && typeof value === "object") {
          walk(value, nextSubtable, depth + 1);
        }
      }
    }

    walk(rawData);
    return {
      mainControls,
      subtables: Array.from(subtablesMap.values())
    };
  }

  function dedupeControls(controls: { code?: string; name?: string }[]): ControlRecord[] {
    const seen = new Set<string>();
    return controls.filter((control): control is ControlRecord => {
      const code = firstReadableText([control?.code]);
      const name = firstReadableText([control?.name]);
      if (!code) {
        return false;
      }
      const key = `${code}|${name}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      control.code = code;
      control.name = name;
      return true;
    });
  }

  function mergeMetadata(selectedData: unknown): {
    formName: string;
    links: ReturnType<typeof extractLinkMetadata>;
    mainControls: ControlRecord[];
    subtables: SubtableRecord[];
  } {
    const domMetadata = extractControlsFromDom();
    const dataMetadata = extractControlsFromData(selectedData);
    const subtablesMap = new Map<string, SubtableRecord>();

    for (const table of [...domMetadata.subtables, ...dataMetadata.subtables]) {
      const code = firstReadableText([table?.code]);
      if (!code) {
        continue;
      }
      if (!subtablesMap.has(code)) {
        subtablesMap.set(code, {
          code,
          name: firstReadableText([table?.name]) || code,
          controls: []
        });
      }
      const existing = subtablesMap.get(code);
      if (existing) {
        existing.controls.push(...(table.controls || []));
      }
    }

    return {
      formName: findFormName(),
      links: extractLinkMetadata(),
      mainControls: dedupeControls([...domMetadata.mainControls, ...dataMetadata.mainControls]),
      subtables: Array.from(subtablesMap.values()).map((table) => ({
        code: table.code,
        name: table.name,
        controls: dedupeControls(table.controls || [])
      }))
    };
  }

  try {
    scanElements();
    scanVueRoots();
  } catch (error) {
    return createBaseResult({
      errorCode: "NO_VUE_ROOT",
      details: error instanceof Error ? error.message : String(error),
      vueMajor,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort()
    });
  }

  if (!discoveredComponentNames.size && !candidateEntries.length) {
    return createBaseResult({
      errorCode: "NO_VUE_ROOT",
      details: "页面上未发现可访问的 Vue 组件入口。"
    });
  }

  candidateEntries.sort((left, right) => {
    if (left.score.visible !== right.score.visible) {
      return left.score.visible ? -1 : 1;
    }
    if (left.score.area !== right.score.area) {
      return right.score.area - left.score.area;
    }
    return left.score.distance - right.score.distance;
  });

  if (!candidateEntries.length) {
    return createBaseResult({
      errorCode: "NO_EDITOR_FOUND",
      vueMajor,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort(),
      details: `未匹配到候选组件名：${candidateNames.join(", ")}`
    });
  }

  const selected = candidateEntries[0];
  if (!selected) {
    return createBaseResult({
      errorCode: "NO_EDITOR_FOUND",
      vueMajor,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort(),
      details: `未匹配到候选组件名：${candidateNames.join(", ")}`
    });
  }

  if (typeof selected.data === "undefined") {
    return createBaseResult({
      errorCode: "NO_DATA",
      vueMajor: selected.vueMajor,
      candidateCount: candidateEntries.length,
      matchedComponentName: selected.componentName,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort(),
      details: "目标组件存在，但未暴露公开的 $data。"
    });
  }

  try {
    const sanitizedData = sanitizeValue(selected.data);
    // 说明：vueMajor/matchedComponentName 为原生附带的诊断字段，超出契约 Success 形状，
    // 故在返回边界做一次断言以保留原生字段名。
    return {
      ok: true,
      pageUrl: safePageUrl(),
      vueMajor: selected.vueMajor,
      matchedComponentName: selected.componentName,
      candidateCount: candidateEntries.length,
      data: sanitizedData,
      metadata: mergeMetadata(sanitizedData),
      discoveredComponentNames: Array.from(discoveredComponentNames).sort()
    } as unknown as PageCaptureResult;
  } catch (error) {
    return createBaseResult({
      errorCode: "SERIALIZE_FAILED",
      vueMajor: selected.vueMajor,
      candidateCount: candidateEntries.length,
      matchedComponentName: selected.componentName,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort(),
      details: error instanceof Error ? error.message : String(error)
    });
  }
}
