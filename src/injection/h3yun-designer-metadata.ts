/**
 * 氚云设计器元数据抓取（主世界注入函数）。
 *
 * 通过 chrome.scripting.executeScript({ world:'MAIN' }) 序列化到目标页面执行，
 * 因此本文件主函数所依赖的全部辅助函数都「嵌套」在主函数体内，
 * 模块顶层只允许出现 import type（编译后擦除，不参与序列化）。
 *
 * 优先读取设计器 Vue 全局 allControls 状态（source:"allControls"），
 * 失败时回退到 DOM 扫描 + Vue 状态遍历 + 编码目录回填（source:"dom"）。
 */

import type { H3yunDesignerMetadataResult } from '../types/injection.js';

export function h3yunDesignerMetadataMain(): H3yunDesignerMetadataResult {
  // ── 局部常量（executeScript 序列化约束：不能引用文件外层常量）──
  const DOM_SCAN_ELEMENT_LIMIT = 5000;
  const VUE_SOURCE_NODE_LIMIT = 1200;
  const CONTENT_SNIPPET_LENGTH = 2000;
  // ── 局部类型：描述主世界里的 Vue / 设计器结构（避免隐式 any） ──────
  interface Vue2Like {
    $props?: unknown;
    _data?: unknown;
    [key: string]: unknown;
  }
  interface Vue3ComponentLike {
    proxy?: unknown;
    ctx?: unknown;
    props?: unknown;
    vnode?: { props?: unknown };
    [key: string]: unknown;
  }
  type VueElement = Element & {
    __vue__?: Vue2Like;
    __vueParentComponent?: Vue3ComponentLike;
  };
  interface SheetFieldEntry {
    code: string;
    displayName: string;
    order: number;
  }
  interface SheetFieldGroup {
    sheetCode: string;
    entries: SheetFieldEntry[];
    names: string[];
    order: number;
  }
  interface DomSheetChild {
    code: string;
    controlKey: string;
    displayName: string;
    index: string;
  }
  interface DomControl {
    code: string;
    controlKey: string;
    displayName: string;
    sheetCode?: string;
    children: DomSheetChild[];
  }
  interface AllControlChild {
    code: string;
    displayName: string;
    controlKey: string;
    defaultValue: string;
    boschemaCode: string;
    displayRule: string;
    defaultItems: unknown[];
  }
  interface AllControl {
    code: string;
    displayName: string;
    controlKey: string;
    sheetCode: string;
    children: AllControlChild[];
    boschemaCode: string;
    defaultValue: string;
    displayRule: string;
    defaultItems: unknown[];
  }
  interface SnapshotAttr {
    name: string;
    value: string;
  }
  interface SnapshotVueKey {
    key: string;
    value: string;
    type: string;
  }
  interface SnapshotSheetControl {
    outerHTML: string;
    attributeKeys: SnapshotAttr[];
    textContent: string;
    vueKeys: SnapshotVueKey[];
  }
  interface SnapshotContainer {
    tagName: string;
    className: string;
    attributeKeys: SnapshotAttr[];
    sheetControls: SnapshotSheetControl[];
  }
  interface SnapshotCatalogGroup {
    sheetCode: string;
    names: string[];
    entryCount: number;
    entries: { code: string; displayName: string }[];
  }
  interface MissingCodeSnapshot {
    sheetFieldCatalog: SnapshotCatalogGroup[];
    sheetContainers: SnapshotContainer[];
  }

  function text(value: unknown): string {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  // 安全转为文本：对象类型（如 DisplayRule）转为 JSON 字符串，避免出现 [object Object]
  function safeText(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch (_) { return ""; }
    }
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function pageParams(): Record<string, string> {
    const url = new URL(window.location.href);
    const hashQuery = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : "";
    return Object.assign(Object.fromEntries(url.searchParams.entries()), Object.fromEntries(new URLSearchParams(hashQuery).entries()));
  }
  function readAttribute(element: Element, names: string[]): string {
    for (const name of names) {
      const value = text(element.getAttribute(name) || element.getAttribute(`data-${name}`));
      if (value) return value;
    }
    return "";
  }
  function readObjectValue(source: unknown, keyHints: string[], excludeValue = ""): string {
    if (!source || typeof source !== "object") return "";
    for (const [key, rawValue] of Object.entries(source as Record<string, unknown>)) {
      const normalizedKey = String(key || "").toLowerCase();
      if (!keyHints.some((hint) => normalizedKey === hint || normalizedKey.includes(hint))) continue;
      const obj = typeof rawValue === "object" && rawValue !== null ? (rawValue as unknown as Record<string, unknown>) : null;
      const value = text(obj ? (obj.zh || obj.name || obj.value) : rawValue);
      if (value && value !== excludeValue) return value;
    }
    return "";
  }
  function readObjectValues(source: unknown, keyHints: string[] = []): { key: string; value: string }[] {
    if (!source || typeof source !== "object") return [];
    const values: { key: string; value: string }[] = [];
    for (const [key, rawValue] of Object.entries(source as Record<string, unknown>)) {
      const normalizedKey = String(key || "").toLowerCase();
      if (keyHints.length && !keyHints.some((hint) => normalizedKey === hint || normalizedKey.includes(hint))) continue;
      if (["string", "number", "boolean"].includes(typeof rawValue)) {
        values.push({ key: normalizedKey, value: text(rawValue) });
      }
    }
    return values.filter((item) => item.value);
  }
  function vueSources(element: Element): unknown[] {
    const sources: unknown[] = [];
    for (let node: VueElement | null = element as VueElement; node && sources.length < 24; node = node.parentElement as VueElement | null) {
      if (node.__vue__) sources.push(node.__vue__, node.__vue__.$props, node.__vue__._data);
      const component = node.__vueParentComponent;
      if (component) sources.push(component.proxy, component.ctx, component.props, component.vnode?.props);
    }
    return sources.filter(Boolean);
  }
  function collectObjects(root: unknown): Record<string, unknown>[] {
    const objects: Record<string, unknown>[] = [];
    const queue: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
    const seen = new WeakSet<object>();
    while (queue.length && objects.length < 800) {
      const item = queue.shift();
      if (!item) continue;
      const { value, depth } = item;
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (value instanceof Element || value instanceof Window) continue;
      objects.push(value as unknown as Record<string, unknown>);
      if (depth >= 5) continue;
      for (const key of Object.keys(value).slice(0, 80)) {
        try {
          const child = (value as Record<string, unknown>)[key];
          if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
        } catch (_error) {}
      }
    }
    return objects;
  }
  function vueControlMetadata(element: Element, displayName: unknown, index: unknown): { code?: string; controlKey?: string; displayName?: string } {
    const labelHints = ["displayname", "label", "title", "fieldname", "controlname", "name"];
    const codeHints = ["controlcode", "fieldcode", "propertycode", "schemacode", "datacode", "code"];
    const typeHints = ["controlkey", "controltype", "widgettype", "componentname", "component", "type"];
    const normalizedName = text(displayName);
    const normalizedIndex = text(index);
    for (const source of vueSources(element)) {
      for (const object of collectObjects(source)) {
        const objectName = readObjectValue(object, labelHints);
        const objectIndex = readObjectValue(object, ["index", "sort", "order"]);
        const nameMatched = objectName && (objectName === normalizedName || objectName.includes(normalizedName) || normalizedName.includes(objectName));
        const indexMatched = normalizedIndex && objectIndex === normalizedIndex;
        if (!nameMatched && !indexMatched) continue;
        const code = readObjectValue(object, codeHints, normalizedName);
        const controlKey = readObjectValue(object, typeHints, normalizedName);
        if (code || controlKey) return { code, controlKey, displayName: objectName };
      }
    }
    return {};
  }
  function inferSheetControlType(item: Element): string {
    if (item.querySelector("textarea")) return "FormTextArea";
    if (item.querySelector(".dropdown")) return "FormDropDown";
    if (item.querySelector("input")) return "FormTextBox";
    return "SheetControl";
  }
  function normalizeSheetFieldCode(value: unknown): string {
    const match = text(value).match(/\b(D[A-Za-z0-9]+)\.(F[A-Za-z0-9]+)\b/);
    return match && match[1] && match[2] ? `${match[1]}.${match[2]}` : "";
  }
  function extractSheetFieldCodes(value: unknown): string[] {
    const source = text(value);
    const codes: string[] = [];
    const pattern = /\b(D[A-Za-z0-9]+)\.(F[A-Za-z0-9]+)\b/g;
    let match = pattern.exec(source);
    while (match) {
      codes.push(`${match[1] ?? ""}.${match[2] ?? ""}`);
      match = pattern.exec(source);
    }
    return codes;
  }
  function sheetCodeFromFieldCode(value: unknown): string {
    return normalizeSheetFieldCode(value).split(".")[0] || "";
  }
  function isFieldCode(value: unknown): boolean {
    return /^F[A-Za-z0-9]+$/.test(text(value));
  }
  function isSheetCode(value: unknown): boolean {
    return /^D[A-Za-z0-9]+$/.test(text(value));
  }
  function namesMatch(left: unknown, right: unknown): boolean {
    const leftName = text(left);
    const rightName = text(right);
    return Boolean(leftName && rightName && (leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName)));
  }
  // 子表字段完整编码通常只出现在设计器全局状态中，格式为"子表编码.F字段编码"，不在具体 .sheet-control 节点上。
  function buildSheetFieldCodeCatalog(root: Element): SheetFieldGroup[] {
    const groups = new Map<string, SheetFieldGroup>();
    const groupOrder: string[] = [];
    let sourceOrder = 0;

    function ensureGroup(sheetCode: unknown, sourceName = ""): SheetFieldGroup | null {
      const normalizedSheetCode = text(sheetCode);
      if (!normalizedSheetCode) return null;
      if (!groups.has(normalizedSheetCode)) {
        groups.set(normalizedSheetCode, { sheetCode: normalizedSheetCode, entries: [], names: [], order: groupOrder.length });
        groupOrder.push(normalizedSheetCode);
      }
      const group = groups.get(normalizedSheetCode);
      if (!group) return null;
      if (sourceName && !group.names.some((name) => namesMatch(name, sourceName))) {
        group.names.push(sourceName);
      }
      return group;
    }

    function register(fullCode: unknown, sourceName = ""): void {
      const normalizedFullCode = normalizeSheetFieldCode(fullCode);
      if (!normalizedFullCode) return;
      const group = ensureGroup(sheetCodeFromFieldCode(normalizedFullCode), sourceName);
      if (!group) return;
      const existing = group.entries.find((entry) => entry.code === normalizedFullCode);
      if (existing) {
        if (sourceName && !existing.displayName) existing.displayName = sourceName;
        return;
      }
      group.entries.push({ code: normalizedFullCode, displayName: sourceName, order: sourceOrder++ });
    }

    function uniqueVueSources(nodes: Element[]): unknown[] {
      const sources: unknown[] = [];
      const seen = new WeakSet<object>();
      for (const node of nodes) {
        for (const source of vueSources(node)) {
          if (!source || typeof source !== "object" || seen.has(source)) continue;
          seen.add(source);
          sources.push(source);
        }
      }
      return sources;
    }

    const domElements = Array.from(root.querySelectorAll("*")).slice(0, DOM_SCAN_ELEMENT_LIMIT);
    for (const element of [root, ...domElements]) {
      const sourceName = text(element.getAttribute?.("title") || (element as HTMLElement).dataset?.displayname || "");
      for (const attribute of Array.from(element.attributes || [])) {
        for (const fullCode of extractSheetFieldCodes(attribute.value)) {
          register(fullCode, sourceName);
        }
      }
    }
    for (const fullCode of extractSheetFieldCodes(root.innerHTML)) {
      register(fullCode);
    }

    // 编码原始数据可能挂在任意子表/字段组件的 Vue 状态上，采集关键节点祖先链比只读根节点更稳。
    const vueSourceNodes = [
      root,
      ...domElements.filter((element) => (
        (element as VueElement).__vue__ ||
        (element as VueElement).__vueParentComponent ||
        element.matches?.("[data-code], .sheet-control, [data-sheet='true'], .grid-view-title")
      ))
    ].slice(0, VUE_SOURCE_NODE_LIMIT);

    for (const source of uniqueVueSources(vueSourceNodes)) {
      for (const object of collectObjects(source)) {
        const sourceName = readObjectValue(object, ["displayname", "label", "title", "fieldname", "controlname", "name"]);
        const primitiveValues = readObjectValues(object);
        for (const item of primitiveValues) {
          for (const fullCode of extractSheetFieldCodes(item.value)) {
            register(fullCode, sourceName);
          }
        }

        const sheetCodes = primitiveValues
          .filter((item) => isSheetCode(item.value) && /(sheet|table|grid|parent|schema|data|code)/.test(item.key))
          .map((item) => item.value);
        const fieldCodes = primitiveValues
          .filter((item) => isFieldCode(item.value) && /(field|control|property|schema|data|code)/.test(item.key))
          .map((item) => item.value);
        for (const sheetCode of sheetCodes) {
          ensureGroup(sheetCode, sourceName);
        }
        if (sheetCodes.length === 1 && fieldCodes.length) {
          for (const fieldCode of fieldCodes) {
            register(`${sheetCodes[0] ?? ""}.${fieldCode}`, sourceName);
          }
        }
      }
    }

    return groupOrder.map((sheetCode) => {
      const group = groups.get(sheetCode);
      if (group) group.entries.sort((left, right) => left.order - right.order);
      return group;
    }).filter((group): group is SheetFieldGroup => Boolean(group));
  }
  function resolveSheetFieldGroup(
    catalog: SheetFieldGroup[],
    control: { code?: string; displayName?: string; children?: readonly { code: string }[] },
  ): SheetFieldGroup | null {
    const children = Array.isArray(control.children) ? control.children : [];
    const controlCode = text(control.code);
    if (controlCode) {
      const byControlCode = catalog.find((group) => group.sheetCode === controlCode);
      if (byControlCode) return byControlCode;
    }

    const directSheetCode = children.map((child) => sheetCodeFromFieldCode(child.code)).find(Boolean);
    if (directSheetCode) {
      return catalog.find((group) => group.sheetCode === directSheetCode) || null;
    }

    const byName = catalog.find((group) => group.names.some((name) => namesMatch(name, control.displayName)));
    if (byName) return byName;

    const childCount = children.length;
    const bySize = catalog.filter((group) => group.entries.length >= childCount);
    return bySize.length === 1 ? (bySize[0] ?? null) : null;
  }
  // 氚云子表内控件在当前 DOM 中常缺少 data-code；最终按"子表编码.F字段编码"的全局顺序回填。
  function childrenOf(container: Element, sheetFieldGroup: SheetFieldGroup | null = null): DomSheetChild[] {
    return Array.from(container.querySelectorAll("[data-sheet='true'] .sheet-control")).map((item, position) => {
      const displayName = text(readAttribute(item, ["title"]) || item.querySelector(".title")?.textContent);
      const index = text(item.getAttribute("index"));
      const vueMetadata = vueControlMetadata(item, displayName, index);
      const rawCode = text(readAttribute(item, ["code", "control-code", "field-code"]) || vueMetadata.code);
      const fieldIndex = Number(index);
      const orderedIndex = Number.isInteger(fieldIndex) && fieldIndex >= 0 ? fieldIndex : position;
      const orderedCode = sheetFieldGroup?.entries?.[orderedIndex]?.code || "";
      return {
        code: text(normalizeSheetFieldCode(rawCode) || orderedCode || rawCode),
        controlKey: text(readAttribute(item, ["controlkey", "control-key", "control-type"]) || vueMetadata.controlKey || inferSheetControlType(item)),
        displayName: text(displayName || vueMetadata.displayName),
        index
      };
    });
  }
  // 子表控件编码缺失时，捕获当前页面 DOM 和 Vue 状态快照，便于诊断编码匹配失败的根因。
  function buildMissingCodeDomSnapshot(root: Element, sheetFieldCatalog: SheetFieldGroup[]): MissingCodeSnapshot {
    const snap: MissingCodeSnapshot = {
      sheetFieldCatalog: [],
      sheetContainers: []
    };

    // 输出全局字段编码目录摘要
    for (let gi = 0; gi < sheetFieldCatalog.length; gi++) {
      const group = sheetFieldCatalog[gi];
      if (!group) continue;
      snap.sheetFieldCatalog.push({
        sheetCode: group.sheetCode,
        names: group.names,
        entryCount: group.entries.length,
        entries: group.entries.map(function (entry) {
          return { code: entry.code, displayName: entry.displayName || "" };
        })
      });
    }

    // 输出每个子表容器的 DOM 结构及 Vue 状态线索
    const sheetContainers = Array.from(root.querySelectorAll("[data-sheet='true']"));
    for (let ci = 0; ci < sheetContainers.length && ci < 20; ci++) {
      const container = sheetContainers[ci];
      if (!container) continue;
      const containerInfo: SnapshotContainer = {
        tagName: String(container.tagName || ""),
        className: String(container.className || ""),
        attributeKeys: Array.from(container.attributes || []).slice(0, 30).map(function (attr) {
          return { name: attr.name, value: String(attr.value || "").substring(0, 300) };
        }),
        sheetControls: []
      };

      const sheetControls = Array.from(container.querySelectorAll(".sheet-control"));
      for (let si = 0; si < sheetControls.length && si < 50; si++) {
        const sc = sheetControls[si];
        if (!sc) continue;
        const controlInfo: SnapshotSheetControl = {
          outerHTML: String(sc.outerHTML || "").substring(0, CONTENT_SNIPPET_LENGTH),
          attributeKeys: Array.from(sc.attributes || []).slice(0, 20).map(function (attr) {
            return { name: attr.name, value: String(attr.value || "").substring(0, 300) };
          }),
          textContent: String(sc.textContent || "").replace(/\s+/g, " ").trim().substring(0, 200),
          vueKeys: []
        };

        // 收集 .sheet-control 节点 Vue 状态中与编码匹配相关的 key
        const sources = vueSources(sc);
        const seenVueKeys: Record<string, boolean> = {};
        for (let vi = 0; vi < sources.length && Object.keys(seenVueKeys).length < 40; vi++) {
          const source = sources[vi];
          if (!source || typeof source !== "object") continue;
          const keys = Object.keys(source).filter(function (k) {
            return /(code|field|control|property|schema|data|type|name|label|title|index|display|sheet|sort|order|key)/i.test(k);
          });
          for (let ki = 0; ki < keys.length && Object.keys(seenVueKeys).length < 40; ki++) {
            const key = keys[ki];
            if (!key || seenVueKeys[key]) continue;
            seenVueKeys[key] = true;
            const rawValue = (source as Record<string, unknown>)[key];
            const type = typeof rawValue;
            let displayValue = "";
            if (type === "string") displayValue = (rawValue as string).substring(0, 150);
            else if (type === "number" || type === "boolean") displayValue = String(rawValue);
            else if (rawValue && type === "object") displayValue = "[object]";
            controlInfo.vueKeys.push({ key: key, value: displayValue, type: type });
          }
        }

        containerInfo.sheetControls.push(controlInfo);
      }

      snap.sheetContainers.push(containerInfo);
    }

    return snap;
  }
  // 检查 controls 中是否有子表控件编码缺失
  function hasMissingChildCodes(controls: DomControl[]): boolean {
    for (let ci = 0; ci < controls.length; ci++) {
      const control = controls[ci];
      const children = control && Array.isArray(control.children) ? control.children : [];
      for (let si = 0; si < children.length; si++) {
        const child = children[si];
        if (child && !String(child.code || "").trim()) return true;
      }
    }
    return false;
  }
  // 从氚云设计器全局 allControls（Vue 实例属性）中提取所有控件的完整信息，
  // 包括自定义编码、关联表单、默认值、选项、显示隐藏规则等。
  // 该方式直接读取设计器状态，不依赖 DOM 属性或 Vue 深度遍历，优先使用。
  function findDesignerAllControls(): Record<string, unknown> | null {
    // 辅助：在 Vue 实例及其 $children/$data/$options 中递归查找 allControls
    function searchVueForAllControls(vueInstance: unknown): Record<string, unknown> | null {
      if (!vueInstance || typeof vueInstance !== "object") return null;
      const vm = vueInstance as Record<string, unknown>;
      // 1. 直接属性
      const direct = vm.allControls;
      if (direct && typeof direct === "object" && Object.keys(direct).length > 0) {
        return direct as Record<string, unknown>;
      }
      // 2. $data
      const data = vm.$data as Record<string, unknown> | undefined;
      if (data?.allControls && typeof data.allControls === "object" && Object.keys(data.allControls).length > 0) {
        return data.allControls as Record<string, unknown>;
      }
      // 3. $options
      const options = vm.$options as Record<string, unknown> | undefined;
      if (options?.allControls && typeof options.allControls === "object" && Object.keys(options.allControls).length > 0) {
        return options.allControls as Record<string, unknown>;
      }
      // 4. 递归 $children
      const children = vm.$children;
      if (Array.isArray(children)) {
        for (let i = 0; i < children.length; i++) {
          const found = searchVueForAllControls(children[i]);
          if (found) return found;
        }
      }
      return null;
    }

    // 5. 页面所有带 __vue__ 的 DOM 元素遍历查找
    function searchAllDomForAllControls(): Record<string, unknown> | null {
      const allElements = document.querySelectorAll("*");
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i] as VueElement | undefined;
        if (el?.__vue__) {
          const found = searchVueForAllControls(el.__vue__);
          if (found) return found;
        }
      }
      return null;
    }

    // 优先通过设计器根节点读取
    const designerRoot = document.querySelector(".designer.web") as VueElement | null;
    if (designerRoot?.__vue__) {
      const found = searchVueForAllControls(designerRoot.__vue__);
      if (found) return found;
    }

    // 回退：从子表控件沿祖先链查找
    const sheetControl = document.querySelector('[data-sheet="true"] .sheet-control') as VueElement | null;
    if (sheetControl) {
      for (let node: VueElement | null = sheetControl; node; node = node.parentElement as VueElement | null) {
        if (node.__vue__) {
          const foundInAncestor = searchVueForAllControls(node.__vue__);
          if (foundInAncestor) return foundInAncestor;
        }
      }
    }

    // 最终回退：遍历所有 DOM 元素的 __vue__ 查找
    return searchAllDomForAllControls();
  }
  // 从 allControls entry 中读取字段值，优先取 entry.options 内的属性（氚云实际数据存放在 options 子对象中），
  // 若 options 中不存在则回退到 entry 顶层属性，兼容不同的数据格式。
  function readAllControlField(entry: Record<string, unknown>, fieldName: string): unknown {
    const opts = entry?.options;
    if (opts && typeof opts === "object") {
      const optsRecord = opts as Record<string, unknown>;
      if (optsRecord[fieldName] !== undefined && optsRecord[fieldName] !== null) {
        return optsRecord[fieldName];
      }
    }
    return entry[fieldName];
  }

  // 将 allControls 原始数据转换为与现有 DOM 扫描一致的 controls 数组格式
  function extractControlsFromAllControls(rawAllControls: Record<string, unknown>, params: Record<string, string>): AllControl[] {
    const entries: { key: string; entry: Record<string, unknown> }[] = [];
    for (const key in rawAllControls) {
      if (!Object.prototype.hasOwnProperty.call(rawAllControls, key)) continue;
      const entry = rawAllControls[key];
      if (!entry || typeof entry !== "object") continue;
      entries.push({ key: key, entry: entry as Record<string, unknown> });
    }
    // 分类：不含点号的是容器控件（主表字段/子表容器），含点号的是子表内字段（sheetCode.fieldCode）
    const containerEntries = entries.filter(function (e) { return e.key.indexOf(".") < 0; });
    const childEntries = entries.filter(function (e) { return e.key.indexOf(".") >= 0; });

    // 将子表字段按 sheetCode（Dxxxxx 前缀）分组
    const childrenBySheetCode: Record<string, AllControlChild[]> = {};
    for (let ci = 0; ci < childEntries.length; ci++) {
      const childEntry = childEntries[ci];
      if (!childEntry) continue;
      const cKey = childEntry.key;
      const cEntry = childEntry.entry;
      const dotIndex = cKey.indexOf(".");
      const sheetCode = cKey.substring(0, dotIndex);
      const fieldCode = cKey.substring(dotIndex + 1);

      if (!childrenBySheetCode[sheetCode]) {
        childrenBySheetCode[sheetCode] = [];
      }
      const bucket = childrenBySheetCode[sheetCode];
      if (!bucket) continue;
      const cDefaultItems = readAllControlField(cEntry, "DefaultItems");
      bucket.push({
        code: fieldCode,
        displayName: text(readAllControlField(cEntry, "DisplayName")),
        // ControlKey（options 内字符串，如 "FormTextBox"）优先于 type（顶层数字，如 301）
        controlKey: text(readAllControlField(cEntry, "ControlKey") || readAllControlField(cEntry, "type")),
        defaultValue: text(readAllControlField(cEntry, "DefaultValue")),
        boschemaCode: text(readAllControlField(cEntry, "BOSchemaCode")),
        displayRule: safeText(readAllControlField(cEntry, "DisplayRule")),
        defaultItems: Array.isArray(cDefaultItems) ? cDefaultItems : (cDefaultItems ? [cDefaultItems] : [])
      });
    }

    // 构建顶层 controls 数组，容器条目按子表类型（FormGridView）判断是否有子表子字段
    const controls: AllControl[] = [];
    const formId = text(params.id);
    void formId;
    for (let ti = 0; ti < containerEntries.length; ti++) {
      const containerEntry = containerEntries[ti];
      if (!containerEntry) continue;
      const tKey = containerEntry.key;
      const tEntry = containerEntry.entry;
      // ControlKey（options 内字符串，如 "FormTextBox"）优先于 type（顶层数字，如 301）
      const controlKey = text(readAllControlField(tEntry, "ControlKey") || readAllControlField(tEntry, "type"));
      const children = childrenBySheetCode[tKey] || [];
      const tDefaultItems = readAllControlField(tEntry, "DefaultItems");

      controls.push({
        code: tKey,
        displayName: text(readAllControlField(tEntry, "DisplayName") || readAllControlField(tEntry, "name")),
        controlKey: controlKey,
        sheetCode: tKey,
        children: children,
        // 以下字段优先从 entry.options 读取（氚云实际数据位于 options 子对象），回退到 entry 顶层
        boschemaCode: text(readAllControlField(tEntry, "BOSchemaCode")),
        defaultValue: text(readAllControlField(tEntry, "DefaultValue")),
        displayRule: safeText(readAllControlField(tEntry, "DisplayRule")),
        defaultItems: Array.isArray(tDefaultItems) ? tDefaultItems : (tDefaultItems ? [tDefaultItems] : [])
      });
    }

    // 处理孤儿子表字段（sheetCode 在 containerEntries 中不存在的情况，比如主表单字段挂在 formId 或 appCode 下面）
    for (const sc in childrenBySheetCode) {
      if (!Object.prototype.hasOwnProperty.call(childrenBySheetCode, sc)) continue;
      const existing = containerEntries.some(function (e) { return e.key === sc; });
      const orphanChildren = childrenBySheetCode[sc];
      if (!existing && orphanChildren && orphanChildren.length > 0) {
        for (let oi = 0; oi < orphanChildren.length; oi++) {
          const orphan = orphanChildren[oi];
          if (!orphan) continue;
          controls.push({
            code: orphan.code,
            displayName: orphan.displayName,
            controlKey: orphan.controlKey,
            sheetCode: "",
            children: [],
            boschemaCode: orphan.boschemaCode,
            defaultValue: orphan.defaultValue,
            displayRule: orphan.displayRule,
            defaultItems: orphan.defaultItems || []
          });
        }
      }
    }

    return controls;
  }

  try {
    const params = pageParams();

    // 优先使用 Vue allControls 全局状态读取完整控件编码（含自定义编码），
    // 该方式直接读取设计器状态，不受 DOM 懒加载影响，编码最完整。
    const designerAllControls = findDesignerAllControls();
    if (designerAllControls && Object.keys(designerAllControls).length > 0) {
      const controls = extractControlsFromAllControls(designerAllControls, params);
      if (controls.length > 0) {
        // 说明：原生 controls 字段（displayName/controlKey/children 等）与契约 ControlMeta 形状不同，
        // 为保留原生字段名，在返回边界做一次断言。
        return { ok: true, pageUrl: window.location.href, appCode: text(params.appcode), formId: text(params.id), controls, source: "allControls" } as unknown as H3yunDesignerMetadataResult;
      }
    }

    // 回退：通过 DOM 扫描 + Vue 状态遍历 + 编码目录回填获取控件编码（兜底逻辑）
    // 氚云设计器主表控件有两种常见结构：
    // 1. 早期版本：.control-container[data-code]
    // 2. 当前版本（如图）：.layout-control__item[data-code]
    // 为避免遗漏，使用 .designer.web [data-code] 并排除已知的非表单控件元素（如左侧工具栏）
    const designerRootForDom = document.querySelector(".designer.web");
    if (!designerRootForDom) {
      return { ok: true, pageUrl: window.location.href, appCode: text(params.appcode), formId: text(params.id), controls: [], source: "dom" } as unknown as H3yunDesignerMetadataResult;
    }
    const allDataCodeElements = Array.from(designerRootForDom.querySelectorAll("[data-code]"));
    // 只取主表控件元素（排除左侧工具栏、拖拽面板等非画布控件）：
    // - control-container：早期氚云版本
    // - layout-control__item：当前氚云版本
    // 子表控件 .sheet-control 不要在此处获取，由 childrenOf() 按子表容器递归获取，避免重复
    const controlElements = allDataCodeElements.filter((el) => {
      const className = String(el.className || "");
      return className.includes("control-container") ||
             className.includes("layout-control__item");
    });
    const sheetFieldCatalog = buildSheetFieldCodeCatalog(designerRootForDom);
    const controls = controlElements.map((item) => {
      const el = item as HTMLElement;
      const control: DomControl = {
        code: text(el.dataset.code),
        controlKey: text(el.dataset.controlkey),
        displayName: text(el.dataset.displayname || item.getAttribute("title")),
        children: []
      };
      const rawChildren = childrenOf(item);
      const sheetFieldGroup = resolveSheetFieldGroup(sheetFieldCatalog, { ...control, children: rawChildren });
      control.sheetCode = sheetFieldGroup?.sheetCode || rawChildren.map((child) => sheetCodeFromFieldCode(child.code)).find(Boolean) || "";
      control.children = childrenOf(item, sheetFieldGroup);
      return control;
    });
    const diagnosticDomSnapshot = hasMissingChildCodes(controls) ? buildMissingCodeDomSnapshot(designerRootForDom, sheetFieldCatalog) : null;
    return { ok: true, pageUrl: window.location.href, appCode: text(params.appcode), formId: text(params.id), controls, source: "dom", _diagnosticDomSnapshot: diagnosticDomSnapshot } as unknown as H3yunDesignerMetadataResult;
  } catch (error) {
    return { ok: false, errorCode: "H3YUN_DESIGNER_METADATA_FAILED", details: error instanceof Error ? error.message : String(error), controls: [] } as unknown as H3yunDesignerMetadataResult;
  }
}
