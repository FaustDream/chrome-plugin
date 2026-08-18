/**
 * 统一异常体系。
 *
 * 编码规范强制要求：
 * - 禁止 throw 非业务异常（裸 "xxx"、裸 Error）
 * - 所有业务异常继承 BusinessError，携带错误码与上下文
 * - 不得静默吞掉异常
 */

/** 错误码枚举（字面量联合） */
export const ERROR_CODE = {
  // 通用
  UNKNOWN: 'ERR_UNKNOWN',
  INVALID_INPUT: 'ERR_INVALID_INPUT',
  TIMEOUT: 'ERR_TIMEOUT',

  // 配置
  CONFIG_LOAD: 'ERR_CONFIG_LOAD',

  // 目录
  DIRECTORY_NOT_SELECTED: 'ERR_DIRECTORY_NOT_SELECTED',
  DIRECTORY_PERMISSION_DENIED: 'ERR_DIRECTORY_PERMISSION_DENIED',

  // 文件操作
  FILE_NOT_FOUND: 'ERR_FILE_NOT_FOUND',

  // 注入
  INJECTION_TIMEOUT: 'ERR_INJECTION_TIMEOUT',

  // 消息协议
  MESSAGE_INVALID_PAYLOAD: 'ERR_MESSAGE_INVALID_PAYLOAD',

  // 预检
  PREFLIGHT_BLOCKED: 'ERR_PREFLIGHT_BLOCKED',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** 业务异常基类：所有 throw 必须使用此类或其子类 */
export class BusinessError extends Error {
  public readonly code: ErrorCode;
  public readonly context: Record<string, unknown>;
  public override readonly cause: unknown | null;

  constructor(
    code: ErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause: unknown = null,
  ) {
    super(message);
    this.name = 'BusinessError';
    this.cause = cause;
    this.code = code;
    this.context = context;
  }

  /** 输出安全的诊断摘要（不含敏感信息） */
  toDiagnostic(): string {
    const parts = [`[${this.code}] ${this.message}`];
    if (this.cause instanceof Error) {
      parts.push(`cause: ${this.cause.message}`);
    }
    return parts.join(' | ');
  }
}

/** 外部输入校验失败 */
export class ValidationError extends BusinessError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(ERROR_CODE.INVALID_INPUT, message, context);
    this.name = 'ValidationError';
  }
}

/** 目录相关异常 */
export class DirectoryError extends BusinessError {
  constructor(
    code: ErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(code, message, context);
    this.name = 'DirectoryError';
  }
}
