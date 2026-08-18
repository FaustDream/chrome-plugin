/**
 * 云枢前端回写（主世界注入函数）。
 *
 * 通过 chrome.scripting.executeScript({ world:'MAIN' }) 序列化到目标页面执行，
 * 因此本文件主函数所依赖的全部辅助函数都「嵌套」在主函数体内，
 * 模块顶层只允许出现 import type（编译后擦除，不参与序列化）。
 */

import type {
  PageWritebackInput,
  PageWritebackResult,
} from '../types/injection.js';

export function pageWritebackMain(input: PageWritebackInput): PageWritebackResult {
  // ── 局部类型：描述主世界里的 Vue2 / Vue3 组件结构（避免隐式 any） ──
  interface Vue2Instance {
    $options?: { name?: string; _componentTag?: string };
    $vnode?: { componentOptions?: { Ctor?: { options?: { name?: string } } } };
    $data?: Record<string, unknown>;
    $el?: Node | null;
    $children?: Vue2Instance[];
    $set?: (target: unknown, key: string, value: unknown) => void;
    webIDEService?: unknown;
    [key: string]: unknown;
  }
  interface Vue3Proxy {
    $options?: { name?: string };
    $data?: Record<string, unknown>;
    webIDEService?: unknown;
    [key: string]: unknown;
  }
  interface Vue3Instance {
    type?: { name?: string; __name?: string };
    proxy?: Vue3Proxy;
    vnode?: { el?: Node | null };
    subTree?: { component?: Vue3Instance; children?: unknown };
    component?: Vue3Instance;
    webIDEService?: unknown;
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

  const DEFAULT_CANDIDATE_NAMES = ["editor"];
  const rawNames = input?.candidateComponentNames;
  const candidateNames: string[] = Array.isArray(rawNames)
    ? rawNames.filter((name): name is string => Boolean(name))
    : DEFAULT_CANDIDATE_NAMES;
  const codeEntries: readonly { readonly key: string; readonly content: string }[] =
    Array.isArray(input.codeEntries) ? input.codeEntries : [];
  const skippedInput = (input as { skippedKeys?: readonly string[] }).skippedKeys;
  const skippedKeys: readonly string[] = Array.isArray(skippedInput) ? skippedInput : [];

  function safePageUrl(): string {
    try {
      return window.location.href;
    } catch (_error) {
      return "";
    }
  }

  function createBaseResult(overrides: Record<string, unknown>): PageWritebackResult {
    const base: Record<string, unknown> = {
      ok: false,
      pageUrl: safePageUrl(),
      candidateCount: 0,
      updatedKeys: [] as string[],
      skippedKeys,
      discoveredComponentNames: [] as string[],
      ...overrides
    };
    return base as unknown as PageWritebackResult;
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

  function ensureCodesTarget(selected: ScoredCandidate): { ok: true; target: Record<string, unknown> } | { ok: false; errorCode: string } {
    if (selected.vueMajor === 2) {
      const vm = selected.instance as Vue2Instance;
      const data = vm?.$data;
      if (!data || typeof data !== "object") {
        return { ok: false, errorCode: "NO_DATA" };
      }

      if (!data.codes || typeof data.codes !== "object" || Array.isArray(data.codes)) {
        if (typeof vm?.$set === "function") {
          vm.$set(data, "codes", {});
        } else {
          data.codes = {};
        }
      }

      if (!data.codes || typeof data.codes !== "object" || Array.isArray(data.codes)) {
        return { ok: false, errorCode: "NO_DATA_CODES_TARGET" };
      }

      return { ok: true, target: data.codes as Record<string, unknown> };
    }

    const data = (selected.instance as Vue3Instance)?.proxy?.$data;
    if (!data || typeof data !== "object") {
      return { ok: false, errorCode: "NO_DATA" };
    }

    if (!data.codes || typeof data.codes !== "object" || Array.isArray(data.codes)) {
      data.codes = {};
    }

    if (!data.codes || typeof data.codes !== "object" || Array.isArray(data.codes)) {
      return { ok: false, errorCode: "NO_DATA_CODES_TARGET" };
    }

    return { ok: true, target: data.codes as Record<string, unknown> };
  }

  function ensureWebIDEServiceCompatibility(selected: ScoredCandidate): { shimmed: boolean; fallbackMethod: string } {
    const vm: unknown = selected?.vueMajor === 2 ? selected?.instance : (selected?.instance as Vue3Instance)?.proxy;
    const vmRecord = (vm && typeof vm === "object" ? vm : null) as Record<string, unknown> | null;
    const instRecord = selected?.instance as Record<string, unknown> | undefined;
    const proxyRecord = (selected?.instance as Vue3Instance)?.proxy as Record<string, unknown> | undefined;
    const vmData = vmRecord?.$data as Record<string, unknown> | undefined;
    const serviceCandidates = [
      vmRecord?.webIDEService,
      instRecord?.webIDEService,
      proxyRecord?.webIDEService,
      vmData?.webIDEService
    ].filter((service): service is Record<string, unknown> => Boolean(service && typeof service === "object"));

    for (const service of serviceCandidates) {
      if (typeof service.updateDataSource === "function") {
        return { shimmed: false, fallbackMethod: "" };
      }

      const fallbackMethod = [
        "updateDatasource",
        "setDataSource",
        "syncDataSource",
        "refreshDataSource"
      ].find((name) => typeof service[name] === "function");

      if (fallbackMethod) {
        service.updateDataSource = (...args: unknown[]) =>
          (service[fallbackMethod] as (...a: unknown[]) => unknown)(...args);
        return { shimmed: true, fallbackMethod };
      }

      service.updateDataSource = () => undefined;
      return { shimmed: true, fallbackMethod: "noop" };
    }

    return { shimmed: false, fallbackMethod: "" };
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

  if (!codeEntries.length) {
    return createBaseResult({
      errorCode: "NO_IMPORTABLE_CODE_FILES",
      vueMajor,
      candidateCount: candidateEntries.length,
      matchedComponentName: candidateEntries[0]?.componentName ?? "",
      discoveredComponentNames: Array.from(discoveredComponentNames).sort(),
      details: "没有可回写的代码文件内容。"
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

  const codesTargetResult = ensureCodesTarget(selected);
  if (!codesTargetResult.ok) {
    return createBaseResult({
      errorCode: codesTargetResult.errorCode,
      vueMajor: selected.vueMajor,
      candidateCount: candidateEntries.length,
      matchedComponentName: selected.componentName,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort(),
      details:
        codesTargetResult.errorCode === "NO_DATA"
          ? "目标组件存在，但未暴露公开的 $data。"
          : "目标组件的 $data.codes 无法建立为可写对象。"
    });
  }

  const compatibilityState = ensureWebIDEServiceCompatibility(selected);

  try {
    const updatedKeys: string[] = [];
    for (const entry of codeEntries) {
      const vm2 = selected.instance as Vue2Instance;
      if (selected.vueMajor === 2 && typeof vm2?.$set === "function") {
        vm2.$set(codesTargetResult.target, entry.key, entry.content);
      } else {
        codesTargetResult.target[entry.key] = entry.content;
      }
      updatedKeys.push(entry.key);
    }

    // 说明：pageUrl/vueMajor/matchedComponentName/candidateCount/skippedKeys/discoveredComponentNames
    // 为原生附带字段，超出契约 Success 形状，故在返回边界做一次断言以保留原生字段名。
    return {
      ok: true,
      pageUrl: safePageUrl(),
      vueMajor: selected.vueMajor,
      matchedComponentName: selected.componentName,
      candidateCount: candidateEntries.length,
      updatedKeys,
      skippedKeys,
      compatibilityState,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort()
    } as unknown as PageWritebackResult;
  } catch (error) {
    return createBaseResult({
      errorCode: "WRITEBACK_FAILED",
      vueMajor: selected.vueMajor,
      candidateCount: candidateEntries.length,
      matchedComponentName: selected.componentName,
      discoveredComponentNames: Array.from(discoveredComponentNames).sort(),
      details: error instanceof Error ? error.message : String(error)
    });
  }
}
