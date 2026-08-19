/**
 * 语义化版本号比较工具。
 *
 * 纯逻辑模块：禁止引用 chrome.* / DOM，便于单元测试。
 * 支持格式：主.次.修订（可含前导 v 或仓库名前缀，如 v2.0.0 / cloudpiovt-plugin-v2.0.0），
 * 可选预发布后缀（如 2.1.0-beta.1）。
 */

/**
 * 从字符串中提取版本号：
 * - 优先匹配语义化版本模式（主.次.修订，可带预发布/构建后缀），兼容 tag 前缀（如 cloudpiovt-plugin-v2.0.0）
 * - 无匹配时退回去掉前导 v / V
 */
export function normalizeVersion(version: string): string {
  const trimmed = version.trim();
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(trimmed);
  const extracted = match?.[1];
  if (extracted) return extracted;
  return trimmed.replace(/^v/i, '');
}

/** 解析核心版本段为数字数组（缺失段补 0，非法段按 0 处理） */
function parseCore(version: string): number[] {
  const [core = ''] = normalizeVersion(version).split('-', 2);
  return core.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * 比较两个语义化版本号。
 * 规则：核心版本逐段比较；核心相同则无预发布 > 有预发布；预发布按字典序比较。
 * 返回：a > b 为 1，a < b 为 -1，相等为 0。
 */
export function compareVersions(a: string, b: string): 1 | -1 | 0 {
  const aParts = parseCore(a);
  const bParts = parseCore(b);
  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  const aPre = normalizeVersion(a).split('-', 2)[1] ?? '';
  const bPre = normalizeVersion(b).split('-', 2)[1] ?? '';
  if (aPre === '' && bPre !== '') return 1;
  if (aPre !== '' && bPre === '') return -1;
  if (aPre === bPre) return 0;
  return aPre < bPre ? -1 : 1;
}
