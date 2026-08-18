/**
 * 业务规则约束检查模块。
 *
 * 业务规则抓取与回写依赖页面内只保留一个有效业务规则编辑器，
 * 多开会让文件名匹配失真。
 */

export const BIZ_RULE_USAGE_NOTICE =
  '业务规则限制：同一页面同时只支持一个业务规则编辑器；若同时打开了多个不同表单或多个业务规则，请先关闭多余业务规则后再抓取或回写。';

export const BIZ_RULE_MISSING_FILE_TROUBLESHOOTING_NOTICE =
  '若日志提示当前文件夹没有对应的 .java 文件，请检查当前页面是否同时打开了多个不同表单或多个业务规则，导致本次操作命中了非预期业务规则。';

export interface ConstraintDetails {
  readonly summary: string;
  readonly details: readonly string[];
}

/** 目标文件缺失详情 */
export function buildBizRuleMissingFileDetails(fileName?: string): ConstraintDetails {
  const normalized = String(fileName || '').trim();
  const summary = normalized
    ? `目标目录中不存在文件：${normalized}`
    : '目标目录中不存在待回写的 .java 文件';
  return { summary, details: [BIZ_RULE_MISSING_FILE_TROUBLESHOOTING_NOTICE] };
}
