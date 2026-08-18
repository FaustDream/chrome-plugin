/**
 * 控件类型元数据模块。
 *
 * 提供云枢（HTML 标签名映射）和氚云（typeCode 映射）两套控件的类型信息，
 * 供 FromCode / README 生成和预检诊断使用。
 */

// ── 云枢控件类型参考 ──────────────────────────────────

interface ControlTypeMeta {
  readonly tagName: string;
  readonly typeName: string;
  readonly exampleName: string;
  readonly notes: string;
  readonly supportsOptions?: boolean;
  readonly supportsAssociation?: boolean;
  readonly supportsDateFormat?: boolean;
}

const RAW_CONTROL_TYPE_REFERENCE: readonly ControlTypeMeta[] = [
  { tagName: 'a-text', typeName: '单行文本', exampleName: '单行文本', notes: '普通文本输入' },
  { tagName: 'a-textarea', typeName: '长文本', exampleName: '长文本', notes: '多行文本输入' },
  { tagName: 'a-date', typeName: '日期', exampleName: '日期', notes: '日期或日期时间', supportsDateFormat: true },
  { tagName: 'a-number', typeName: '数值', exampleName: '数值', notes: '整数或小数' },
  { tagName: 'a-radio', typeName: '单选框', exampleName: '单选框', notes: '会提取控件选项', supportsOptions: true },
  { tagName: 'a-checkbox', typeName: '复选框', exampleName: '复选框', notes: '会提取控件选项', supportsOptions: true },
  { tagName: 'a-dropdown', typeName: '下拉单选框', exampleName: '下拉单选框', notes: '会提取控件选项', supportsOptions: true },
  { tagName: 'a-dropdown-multi', typeName: '下拉多选框', exampleName: '下拉多选框', notes: '会提取控件选项', supportsOptions: true },
  { tagName: 'a-logic', typeName: '逻辑', exampleName: '逻辑', notes: '布尔开关类控件' },
  { tagName: 'a-attachment', typeName: '附件', exampleName: '附件', notes: '文件上传' },
  { tagName: 'a-image', typeName: '图片', exampleName: '图片', notes: '图片上传' },
  { tagName: 'a-signature', typeName: '手写签名', exampleName: '手写签名', notes: '签字板' },
  { tagName: 'a-location', typeName: '地址', exampleName: '地址', notes: '定位地址' },
  { tagName: 'a-user-selector', typeName: '人员单选', exampleName: '人员单选', notes: '单选人员' },
  { tagName: 'a-user-multi-selector', typeName: '人员多选', exampleName: '人员多选', notes: '多选人员' },
  { tagName: 'a-departmentselector', typeName: '部门单选', exampleName: '部门单选', notes: '单选部门' },
  { tagName: 'a-departmentmultiselector', typeName: '部门多选', exampleName: '部门多选', notes: '多选部门' },
  { tagName: 'a-staffdeptmixed', typeName: '混合选人', exampleName: '混合选人', notes: '人员与部门混合选择' },
  { tagName: 'a-rate', typeName: '评分', exampleName: '评分', notes: '星级评分' },
  { tagName: 'a-sequence-no', typeName: '单据号', exampleName: '单据号', notes: '系统流水号' },
  { tagName: 'a-create-by', typeName: '创建人', exampleName: '创建人', notes: '系统字段' },
  { tagName: 'a-create-by-org', typeName: '创建人部门', exampleName: '创建人部门', notes: '系统字段' },
  { tagName: 'a-owner', typeName: '拥有者', exampleName: '拥有者', notes: '系统字段' },
  { tagName: 'a-ownerdeptid', typeName: '拥有者部门', exampleName: '拥有者部门', notes: '系统字段' },
  { tagName: 'a-created-time', typeName: '创建时间', exampleName: '创建时间', notes: '系统字段' },
  { tagName: 'a-modified-time', typeName: '修改时间', exampleName: '修改时间', notes: '系统字段' },
  { tagName: 'a-modify-b', typeName: '修改人', exampleName: '修改人', notes: '系统字段' },
  { tagName: 'a-association-form', typeName: '关联单选', exampleName: '关联单选', notes: '需补充关联表单信息', supportsAssociation: true },
  { tagName: 'a-relevance-form-multi', typeName: '关联多选', exampleName: '关联多选', notes: '需补充关联表单信息', supportsAssociation: true },
  { tagName: 'a-select', typeName: '选择器', exampleName: '选择器', notes: '兼容历史标签', supportsOptions: true },
  { tagName: 'a-input', typeName: '输入框', exampleName: '输入框', notes: '兼容历史标签' },
];

// ── 氚云控件类型参考 ──────────────────────────────────

interface H3yunControlTypeMeta {
  readonly typeCode: string;
  readonly typeName: string;
  readonly exampleName: string;
  readonly notes: string;
}

const RAW_H3YUN_CONTROL_TYPE_REFERENCE: readonly H3yunControlTypeMeta[] = [
  { typeCode: 'FormGridView', typeName: '子表', exampleName: '子表', notes: '承载明细行，子表内控件会继续按子控件编码输出' },
  { typeCode: 'FormTextBox', typeName: '单行文本', exampleName: '单行文本', notes: '普通短文本输入' },
  { typeCode: 'FormTextArea', typeName: '多行文本', exampleName: '多行文本', notes: '多行长文本输入' },
  { typeCode: 'FormDateTime', typeName: '日期', exampleName: '日期', notes: '日期或日期时间字段' },
  { typeCode: 'FormNumber', typeName: '数字', exampleName: '数字', notes: '整数、小数、金额等数值输入' },
  { typeCode: 'FormRadioButtonList', typeName: '单选框', exampleName: '单选框', notes: '从预设选项中选择一个值' },
  { typeCode: 'FormCheckboxList', typeName: '复选框', exampleName: '复选框', notes: '从预设选项中选择多个值' },
  { typeCode: 'FormDropDownList', typeName: '下拉框', exampleName: '下拉框', notes: '下拉单选类字段' },
  { typeCode: 'FormCheckbox', typeName: '是/否', exampleName: '是/否', notes: '布尔开关类字段' },
  { typeCode: 'FormAttachment', typeName: '附件', exampleName: '附件', notes: '文件上传字段' },
  { typeCode: 'FormPhoto', typeName: '图片', exampleName: '图片', notes: '图片上传字段' },
  { typeCode: 'FormAreaSelect', typeName: '地址', exampleName: '地址', notes: '省市区等区域地址选择' },
  { typeCode: 'FormMap', typeName: '位置', exampleName: '位置', notes: '地图定位字段' },
  { typeCode: 'FormUser', typeName: '人员单选', exampleName: '人员单选', notes: '选择一个组织人员' },
  { typeCode: 'FormMultiUser', typeName: '人员多选', exampleName: '人员多选', notes: '选择多个组织人员' },
  { typeCode: 'FormDepartment', typeName: '部门单选', exampleName: '部门单选', notes: '选择一个组织部门' },
  { typeCode: 'FormMultiDepartment', typeName: '部门多选', exampleName: '部门多选', notes: '选择多个组织部门' },
];

// ── 导出（冻结为只读） ─────────────────────────────────

export const CONTROL_TYPE_REFERENCE: readonly ControlTypeMeta[] = RAW_CONTROL_TYPE_REFERENCE;
export const H3YUN_CONTROL_TYPE_REFERENCE: readonly H3yunControlTypeMeta[] = RAW_H3YUN_CONTROL_TYPE_REFERENCE;

const CONTROL_TYPE_MAP = new Map<string, ControlTypeMeta>(
  CONTROL_TYPE_REFERENCE.map((item) => [item.tagName.toLowerCase(), item]),
);

function normalizeTagName(tagName: unknown): string {
  return String(tagName || '').trim().toLowerCase();
}

/** 获取云枢控件类型元数据（含兜底） */
export function getControlTypeMeta(tagName: string): ControlTypeMeta {
  const normalized = normalizeTagName(tagName);
  return CONTROL_TYPE_MAP.get(normalized) ?? {
    tagName: normalized,
    typeName: '未归类控件',
    exampleName: '',
    notes: '请根据页面 HTML 补充类型映射',
  };
}

/** 格式化控件类型标签 */
export function formatControlTypeLabel(tagName: string): string {
  const meta = getControlTypeMeta(tagName);
  return `${meta.tagName}（${meta.typeName}）`;
}

/** 控件是否支持自定义选项 */
export function supportsCustomOptions(tagName: string): boolean {
  return getControlTypeMeta(tagName).supportsOptions === true;
}

/** 控件是否支持关联单据元数据 */
export function supportsAssociationMetadata(tagName: string): boolean {
  return getControlTypeMeta(tagName).supportsAssociation === true;
}

/** 控件是否支持日期格式（data-format1） */
export function supportsDateFormat(tagName: string): boolean {
  return getControlTypeMeta(tagName).supportsDateFormat === true;
}
