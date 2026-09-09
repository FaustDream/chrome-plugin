/**
 * 设置页控制器 v4 — 纯浏览器模式，File System Access API。
 */
import type { PlatformKey } from '../types/platform.js';
import type { ExtensionConfig } from '../types/config.js';
import { logger } from '../lib/logger.js';
import { loadConfig, saveConfig, getFallbackDirectoryPathByPlatform, CLOUDPIVOT_READONLY_SETTINGS, H3YUN_READONLY_SETTINGS } from '../services/config.js';
import { CONTROL_TYPE_REFERENCE, H3YUN_CONTROL_TYPE_REFERENCE } from '../lib/platform/control-metadata.js';
import { buildDiagnosticPackage, saveLastDiagnosticPackage, loadLastDiagnosticPackage } from '../services/preflight-diagnostics.js';
import { fetchLatestRelease, isUpToDate, hasNewerVersion, type LatestReleaseInfo } from '../services/update-checker.js';
import { CURRENT_EXTENSION_VERSION } from '../lib/release-notes.js';
import { saveDefaultDirectoryHandle, clearDefaultDirectoryHandle } from '../lib/directory/file-handle-db.js';

// ── 工具 ──────────────────────────────────────────────

function $(sel: string): HTMLElement | null { return document.querySelector(sel) as HTMLElement | null; }
function $$(sel: string): NodeListOf<HTMLElement> { return document.querySelectorAll(sel) as NodeListOf<HTMLElement>; }
function escapeHtml(s: string): string {
  const m: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return s.replace(/[&<>"']/g, (ch) => m[ch] || ch);
}

function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const el = $('.toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast toast-${type} toast-visible`;
  el.removeAttribute('hidden');
  setTimeout(() => { el.className = 'toast'; el.setAttribute('hidden', ''); }, 2500);
}

// ── 状态 ──────────────────────────────────────────────

const COLLAPSE_STATE_KEY = 'optionsCollapseState';

const state = {
  config: null as ExtensionConfig | null,
  activeHelpPlatform: 'cloudpivot' as 'cloudpivot' | 'h3yun',
  collapseStateCache: {} as Record<string, boolean>,
};

async function showConfirm(message: string): Promise<boolean> {
  const overlay = $('#confirm-overlay');
  const msgEl = $('#confirm-message');
  if (!overlay || !msgEl) return false;
  msgEl.textContent = message;
  overlay.removeAttribute('hidden');
  return new Promise<boolean>((resolve) => {
    const cleanup = (result: boolean) => {
      overlay.setAttribute('hidden', '');
      $('#confirm-ok-btn')?.removeEventListener('click', onOk);
      $('#confirm-cancel-btn')?.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    $('#confirm-ok-btn')?.addEventListener('click', onOk, { once: true });
    $('#confirm-cancel-btn')?.addEventListener('click', onCancel, { once: true });
  });
}

// ── 1. 文件助手（File System Access API + 文件生成） ──

const GENFILE_LABELS: Record<string, string> = {
  fromCode: 'FromCode.md', css: 'CSS', js: 'JavaScript', html: 'HTML', cs: 'C#',
  readme: 'README.md', agents: 'AGENTS.md', design: 'DESIGN.md',
};

function renderAllGenfiles(): void {
  if (!state.config) return;
  const cpKeys = ['fromCode', 'css', 'js', 'html', 'readme', 'agents', 'design'];
  const hyKeys = ['fromCode', 'js', 'cs', 'readme', 'agents', 'design'];
  const cpConfig = (state.config.generatedFiles.cloudpivot ?? {}) as unknown as Record<string, boolean>;
  const hyConfig = (state.config.generatedFiles.h3yun ?? {}) as unknown as Record<string, boolean>;

  fillGenfilesBlock('#genfiles-cloudpivot', cpKeys, 'cloudpivot', cpConfig);
  fillGenfilesBlock('#genfiles-h3yun', hyKeys, 'h3yun', hyConfig);

  // 氚云一键回写开关
  const cb = $('#h3yun-oneclick-writeback') as HTMLInputElement | null;
  if (cb) cb.checked = state.config.h3yunOneClickWriteback;
}

function fillGenfilesBlock(sel: string, keys: string[], platform: string, config: Record<string, boolean>): void {
  const container = $(sel);
  if (!container) return;
  container.innerHTML = '';
  for (const key of keys) {
    if (key === 'fromCode') continue; // fromCode 始终生成，只读不勾选
    const row = document.createElement('label');
    row.className = 'toggle-row';
    const id = `genfile-${platform}-${key}`;
    row.innerHTML = `<input type="checkbox" id="${id}" data-genfiles-platform="${platform}" data-genfiles-key="${key}"
        ${config[key] === true ? 'checked' : ''}>
      <span>${GENFILE_LABELS[key] || key}</span>`;
    container.appendChild(row);
  }
}

function syncGenfilesFromDom(): void {
  if (!state.config) return;
  const inputs = $$('[data-genfiles-platform][data-genfiles-key]');
  for (const inp of inputs) {
    const p = inp.dataset.genfilesPlatform || '';
    const k = inp.dataset.genfilesKey || '';
    if (p && k) {
      const pf = state.config.generatedFiles as unknown as Record<string, Record<string, boolean>>;
      if (!pf[p]) pf[p] = {};
      pf[p]![k] = (inp as HTMLInputElement).checked;
    }
  }
  const oc = $('#h3yun-oneclick-writeback') as HTMLInputElement | null;
  state.config = { ...state.config, h3yunOneClickWriteback: oc?.checked ?? true };
}

function bindGenfileInputs(): void {
  $$('[data-genfiles-platform][data-genfiles-key]').forEach((cb) => {
    const fresh = cb.cloneNode(true) as HTMLInputElement;
    cb.parentNode?.replaceChild(fresh, cb);
    fresh.addEventListener('change', syncGenfilesFromDom);
  });
  const oc = $('#h3yun-oneclick-writeback') as HTMLInputElement | null;
  if (oc) {
    const fresh = oc.cloneNode(true) as HTMLInputElement;
    oc.parentNode?.replaceChild(fresh, oc);
    fresh.addEventListener('change', () => syncGenfilesFromDom());
  }
}

// ── 2. 默认目录（双行并行） ───────────────────────────

function renderDefaultDirs(): void {
  if (!state.config) return;
  const cpInput = $('#default-dir-cloudpivot') as HTMLInputElement | null;
  const hyInput = $('#default-dir-h3yun') as HTMLInputElement | null;
  if (cpInput) cpInput.value = getFallbackDirectoryPathByPlatform(state.config, 'cloudpivot');
  if (hyInput) hyInput.value = getFallbackDirectoryPathByPlatform(state.config, 'h3yun');
}

/** 通过原生目录选择器浏览并绑定平台默认目录（保存句柄 + 回填路径字符串） */
async function pickDefaultDirectory(platformKey: PlatformKey): Promise<void> {
  const w = window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== 'function') {
    showToast('当前浏览器不支持目录选择，请使用 Chrome 86+ 或 Edge 86+', 'error');
    return;
  }
  try {
    const handle = await w.showDirectoryPicker({ mode: 'read' });
    const label = handle.name || '';
    const input = platformKey === 'h3yun' ? $('#default-dir-h3yun') : $('#default-dir-cloudpivot');
    if (input) (input as HTMLInputElement).value = label;
    await saveDefaultDirectoryHandle(handle, platformKey);
    showToast(label ? `已选择默认目录：${label}` : '已选择默认目录', 'success');
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') return; // 用户取消
    logger.error('选择默认目录失败', { error: String(error) });
    showToast('选择目录失败', 'error');
  }
}

// ── 3. 使用说明 ───────────────────────────────────────

function setActiveHelpPlatform(key: 'cloudpivot' | 'h3yun'): void {
  state.activeHelpPlatform = key;
  for (const t of $$('[data-help-platform]')) {
    const on = t.dataset.helpPlatform === key;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const p of $$('[data-help-panel]')) {
    p.hidden = p.dataset.helpPanel !== key;
  }
}

function renderHelpSection(): void {
  const cpBody = $('#cloudpivot-control-ref-body');
  if (cpBody) cpBody.innerHTML = CONTROL_TYPE_REFERENCE.map(c => `<tr><td>${escapeHtml(c.tagName)}</td><td>${escapeHtml(c.typeName)}</td><td>${escapeHtml(c.notes)}</td></tr>`).join('');
  const hyBody = $('#h3yun-control-ref-body');
  if (hyBody) hyBody.innerHTML = H3YUN_CONTROL_TYPE_REFERENCE.map(c => `<tr><td>${escapeHtml(c.typeCode)}</td><td>${escapeHtml(c.typeName)}</td><td>${escapeHtml(c.notes)}</td></tr>`).join('');
  const cpRules = $('#cloudpivot-rules-list');
  const hyRules = $('#h3yun-rules-list');
  if (cpRules) cpRules.innerHTML = CLOUDPIVOT_READONLY_SETTINGS.map(s => `<li>${escapeHtml(s)}</li>`).join('');
  if (hyRules) hyRules.innerHTML = H3YUN_READONLY_SETTINGS.map(s => `<li>${escapeHtml(s)}</li>`).join('');
  setActiveHelpPlatform('cloudpivot');
}

// ── 4. 问题排查 ───────────────────────────────────────

function updateDiagnosticInfo(): void {
  const m = chrome.runtime.getManifest();
  setText('#diag-version', `${m.name || '开发助手'} v${m.version || ''}`);
  setHtml('#diag-permissions', (m.permissions || []).map(p => `<code>${escapeHtml(p)}</code>`).join(', ') || '无');
  setText('#diag-browser', navigator.userAgent);
  const fsa = $('#diag-file-access');
  if (fsa) {
    const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    fsa.innerHTML = supported
      ? '<span style="color:green;">&#10003; 已支持</span> File System Access API'
      : '<span style="color:red;">&#10007; 不支持</span> 请使用 Chrome 86+ 或 Edge 86+';
  }
}

function setText(sel: string, v: string): void { const el = $(sel); if (el) el.textContent = v; }
function setHtml(sel: string, v: string): void { const el = $(sel); if (el) el.innerHTML = v; }

async function handleDiagHealthCheck(): Promise<void> {
  try {
    updateDiagnosticInfo();
    const pkg = buildDiagnosticPackage({
      operationId: 'diagHealthCheck', browser: { userAgent: navigator.userAgent }, extension: { name: '开发助手', version: CURRENT_EXTENSION_VERSION },
    } as Record<string, unknown>);
    await saveLastDiagnosticPackage(pkg as unknown as Record<string, unknown>);
    showToast('全面检查完成', 'success');
    const summary = $('#last-diagnostic-summary'); const output = $('#status-output');
    if (summary) summary.textContent = `最近诊断: ${new Date().toLocaleString('zh-CN')}`;
    if (output) output.textContent = JSON.stringify(pkg, null, 2);
  } catch (err: unknown) {
    logger.error('全面检查失败', { error: String(err) });
    showToast(`检查失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function handleDiagCopyAll(): Promise<void> {
  try {
    const m = chrome.runtime.getManifest();
    const fsa = typeof window !== 'undefined' && 'showDirectoryPicker' in window ? 'supported' : 'not supported';
    await navigator.clipboard.writeText(`fileSystemAccess: ${fsa}\n${m.name} v${m.version}\nbrowser: ${navigator.userAgent}\npermissions: ${(m.permissions||[]).join(', ')}`);
    showToast('已复制', 'success');
  } catch (err: unknown) {
    logger.error('复制诊断失败', { error: String(err) });
    showToast(`复制失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function handleDiagCopySummary(): Promise<void> {
  try {
    const pkg = buildDiagnosticPackage({} as Record<string, unknown>);
    const summary = JSON.stringify(pkg, null, 2);
    await navigator.clipboard.writeText(summary);
    showToast('摘要已复制', 'success');
  } catch (err: unknown) {
    logger.error('复制摘要失败', { error: String(err) });
    showToast(`复制失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function handleDiagExportLast(): Promise<void> {
  try {
    const pkg = await loadLastDiagnosticPackage();
    if (!pkg) { showToast('暂无诊断数据，请先执行全面检查', 'info'); return; }
    const text = JSON.stringify(pkg, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `cloudpiovt-diagnostic-${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast('诊断包已导出', 'success');
  } catch (err: unknown) {
    logger.error('导出诊断失败', { error: String(err) });
    showToast(`导出失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function handleDiagExport(): Promise<void> {
  try {
    const pkg = buildDiagnosticPackage({ operationId: 'diagExport', browser: { userAgent: navigator.userAgent }, extension: { name: '开发助手', version: CURRENT_EXTENSION_VERSION } } as Record<string, unknown>);
    const text = JSON.stringify(pkg, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `cloudpiovt-diagnostic-${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast('诊断包已导出', 'success');
  } catch (err: unknown) {
    logger.error('导出 JSON 失败', { error: String(err) });
    showToast(`导出失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

// ── 4.5 项目更新 ─────────────────────────────────────

let latestRelease: LatestReleaseInfo | null = null;

function renderUpdateResult(): void {
  const resultEl = $('#update-result');
  const statusEl = $('#update-status-text');
  const actionsEl = $('#update-actions');
  const downloadLink = $('#update-download-link') as HTMLAnchorElement | null;
  const openLink = $('#update-open-link') as HTMLAnchorElement | null;
  if (!resultEl || !statusEl || !actionsEl || !downloadLink || !openLink) return;

  if (!latestRelease) {
    resultEl.hidden = true;
    actionsEl.hidden = true;
    return;
  }

  resultEl.hidden = false;
  // 始终把「前往下载页面」指向 GitHub Release 页（即使已是最新也可查看历史版本）
  openLink.href = latestRelease.htmlUrl;

  if (isUpToDate(latestRelease)) {
    statusEl.textContent = `当前已是最新版本 v${CURRENT_EXTENSION_VERSION}，无需更新。`;
    actionsEl.hidden = true;
    return;
  }

  const published = latestRelease.publishedAt
    ? new Date(latestRelease.publishedAt).toLocaleString('zh-CN')
    : '未知';
  statusEl.textContent = `发现新版本 v${latestRelease.version}（发布于 ${published}）。点击「下载最新版」保存 zip 安装包，或在浏览器中解压后侧载。`;
  actionsEl.hidden = false;
  if (latestRelease.zipUrl) {
    downloadLink.href = latestRelease.zipUrl;
    downloadLink.download = latestRelease.zipName || `${latestRelease.tagName}.zip`;
    downloadLink.hidden = false;
  } else {
    downloadLink.hidden = true;
  }
}

async function handleCheckUpdate(): Promise<void> {
  const btn = $('#update-check-btn') as HTMLButtonElement | null;
  if (!btn) return;
  if (btn.classList.contains('is-running')) return;
  btn.classList.add('is-running');
  btn.disabled = true;
  try {
    latestRelease = await fetchLatestRelease();
    renderUpdateResult();
    showToast(
      hasNewerVersion(latestRelease)
        ? `发现新版本 v${latestRelease.version}`
        : '已是最新版本',
      hasNewerVersion(latestRelease) ? 'info' : 'success',
    );
  } catch (err: unknown) {
    latestRelease = null;
    renderUpdateResult();
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('检查更新失败', { error: msg });
    showToast(`检查更新失败: ${msg}`, 'error');
  } finally {
    btn.classList.remove('is-running');
    btn.disabled = false;
  }
}

// ── 5. 保存 / 重置 ────────────────────────────────────

async function handleSubmit(): Promise<void> {
  syncGenfilesFromDom();
  if (!state.config) return;
  const cpPath = ($('#default-dir-cloudpivot') as HTMLInputElement | null)?.value || '';
  const hyPath = ($('#default-dir-h3yun') as HTMLInputElement | null)?.value || '';

  try {
    await saveConfig({
      generatedFiles: state.config.generatedFiles,
      h3yunOneClickWriteback: state.config.h3yunOneClickWriteback,
      fallbackDirectoryPaths: { cloudpivot: cpPath, h3yun: hyPath },
    });
    // 默认目录被清空时同步清空对应句柄，避免路径字符串与句柄不一致
    if (!cpPath.trim()) await clearDefaultDirectoryHandle('cloudpivot');
    if (!hyPath.trim()) await clearDefaultDirectoryHandle('h3yun');
    state.config = await loadConfig();
    showToast('配置已保存', 'success');
  } catch (err: unknown) {
    logger.error('保存配置失败', { error: String(err) });
    showToast(`保存失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function handleReset(): Promise<void> {
  if (!await showConfirm('确定恢复默认设置？')) return;
  state.config = await loadConfig();
  renderAllConfigUI(state.config);
  showToast('已恢复当前保存的设置', 'info');
}

function renderAllConfigUI(config: ExtensionConfig): void {
  renderAllGenfiles(); bindGenfileInputs();
  renderDefaultDirs();
}

// ── 6. Sidebar / 折叠 ─────────────────────────────────

function loadCollapse(): Record<string, boolean> { return state.collapseStateCache; }
function saveCollapse(next: Record<string, boolean>): void { state.collapseStateCache = next; void chrome.storage.local.set({ [COLLAPSE_STATE_KEY]: next }); }

function bindCollapse(initial: Record<string, boolean>): void {
  for (const sec of $$('section[data-section]')) {
    const head = sec.querySelector('.section-head'); if (!head) continue;
    const key = sec.dataset.section || '';
    if (initial[key]) { sec.classList.add('is-collapsed'); head.setAttribute('aria-expanded', 'false'); }
    head.addEventListener('click', () => {
      const will = !sec.classList.contains('is-collapsed');
      sec.classList.toggle('is-collapsed', will);
      head.setAttribute('aria-expanded', will ? 'false' : 'true');
      const c = loadCollapse();
      if (will) c[key] = true; else delete c[key];
      saveCollapse(c);
    });
  }
}

function bindSidebar(): void {
  for (const item of $$('.sidebar-item[data-nav-target]')) {
    item.addEventListener('click', () => {
      const key = item.dataset.navTarget || '';
      const sec = document.querySelector<HTMLElement>(`section[data-section="${key}"]`);
      if (!sec) return;
      const head = sec.querySelector('.section-head');
      if (sec.classList.contains('is-collapsed')) {
        sec.classList.remove('is-collapsed'); if (head) head.setAttribute('aria-expanded', 'true');
        const c = loadCollapse(); delete c[key]; saveCollapse(c);
      }
      const tb = document.querySelector('.top-bar'); const tbH = tb?.getBoundingClientRect().height || 52;
      window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - tbH - 16, behavior: 'smooth' });
    });
  }
}

let spyTimer: ReturnType<typeof setTimeout> | null = null;
function updateSidebarSpy(): void {
  const secs = Array.from($$('section[data-section]'));
  const tbH = document.querySelector('.top-bar')?.getBoundingClientRect().height || 52;
  const mid = window.scrollY + tbH + 60;
  let active = secs[0]?.dataset.section ?? '';
  for (const s of secs) { if (mid >= s.getBoundingClientRect().top + window.scrollY) active = s.dataset.section || active; }
  for (const item of $$('.sidebar-item[data-nav-target]')) item.classList.toggle('is-active', (item as HTMLElement).dataset.navTarget === active);
}

function bindExpandAll(): void {
  const btn = $('#expand-all-btn'); if (!btn) return;
  btn.addEventListener('click', () => {
    const secs = Array.from($$('section[data-section]'));
    const allCollapsed = secs.every(s => s.classList.contains('is-collapsed'));
    const ns: Record<string, boolean> = {};
    for (const s of secs) {
      const collapsed = !allCollapsed; const key = s.dataset.section || '';
      s.classList.toggle('is-collapsed', collapsed);
      const h = s.querySelector('.section-head'); if (h) h.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      if (collapsed) ns[key] = true;
    }
    saveCollapse(allCollapsed ? {} : ns);
    btn.textContent = allCollapsed ? '全部折叠' : '全部展开';
  });
}

// ── 7. 事件绑定 ───────────────────────────────────────

function bindEvents(): void {
  // 文件生成
  bindGenfileInputs();

  // 默认目录浏览按钮
  for (const btn of $$('[data-default-dir-platform]')) {
    btn.addEventListener('click', () => {
      const key = (btn as HTMLElement).dataset.defaultDirPlatform;
      if (key === 'cloudpivot' || key === 'h3yun') void pickDefaultDirectory(key);
    });
  }

  // 保存/重置
  $('#save-btn')?.addEventListener('click', () => { void handleSubmit(); });
  $('#reset-btn')?.addEventListener('click', () => { void handleReset(); });

  // 问题排查
  $('#diag-health-check-btn')?.addEventListener('click', () => { void handleDiagHealthCheck(); });
  $('#diag-copy-all-btn')?.addEventListener('click', () => { void handleDiagCopyAll(); });
  $('#copy-diagnostic-summary-btn')?.addEventListener('click', () => { void handleDiagCopySummary(); });
  $('#export-last-diagnostic-btn')?.addEventListener('click', () => { void handleDiagExportLast(); });
  $('#diag-export-btn')?.addEventListener('click', () => { void handleDiagExport(); });

  // 项目更新
  $('#update-check-btn')?.addEventListener('click', () => { void handleCheckUpdate(); });
  // 「下载最新版」为原生 <a download href="zipUrl">，由浏览器直接下载，无需 JS 拦截

  // 使用说明平台切换
  for (const t of $$('[data-help-platform]')) {
    t.addEventListener('click', () => setActiveHelpPlatform(t.dataset.helpPlatform as 'cloudpivot' | 'h3yun'));
  }

  // Sidebar
  bindSidebar();
  bindExpandAll();
}

// ── 8. 初始化 ─────────────────────────────────────────

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get({ [COLLAPSE_STATE_KEY]: {} });
  state.collapseStateCache = (stored[COLLAPSE_STATE_KEY] && typeof stored[COLLAPSE_STATE_KEY] === 'object' ? stored[COLLAPSE_STATE_KEY] : {}) as Record<string, boolean>;

  state.config = await loadConfig();
  renderAllConfigUI(state.config);
  renderHelpSection();
  updateDiagnosticInfo();

  // 项目更新：填充当前版本号
  const curVerEl = $('#update-current-version');
  if (curVerEl) curVerEl.textContent = `v${CURRENT_EXTENSION_VERSION}`;

  bindCollapse(state.collapseStateCache);

  window.addEventListener('scroll', () => { if (spyTimer) clearTimeout(spyTimer); spyTimer = setTimeout(updateSidebarSpy, 80); }, { passive: true });
  updateSidebarSpy();
}

document.addEventListener('DOMContentLoaded', () => { bindEvents(); init().catch(e => logger.error('Init failed', { error: String(e) })); });