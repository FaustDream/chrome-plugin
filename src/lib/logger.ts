/**
 * 统一日志入口。
 *
 * 编码规范强制要求：
 * - 禁止 console.* 散落，所有日志经此模块
 * - 禁止循环/高频路径无节制打日志
 * - 禁止记录敏感信息（密钥、令牌、完整请求体）
 * - 生产环境遵循日志级别
 */

/** 日志级别 */
export const LOG_LEVEL = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
} as const;

export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

let currentLevel: LogLevel = LOG_LEVEL.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** 日志条目（结构化） */
export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

/** 运行时日志缓冲（供诊断导出） */
const logBuffer: LogEntry[] = [];
const MAX_LOG_BUFFER = 500;

function pushLog(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_BUFFER);
  }
}

function redactSensitive(context: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['token', 'password', 'secret', 'key', 'apiKey', 'accessToken'];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    out[k] = sensitiveKeys.some((sk) => k.toLowerCase().includes(sk.toLowerCase()))
      ? '[REDACTED]'
      : v;
  }
  return out;
}

function formatMessage(message: string, context?: Record<string, unknown>): string {
  const ctxStr = context && Object.keys(context).length > 0
    ? ` ${JSON.stringify(redactSensitive(context))}`
    : '';
  return `[cloudpiovt-plugin] ${message}${ctxStr}`;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVEL.DEBUG) {
      const sanitized = context ? redactSensitive(context) : undefined;
      const formatted = formatMessage(message, context);
      console.debug(formatted);
      pushLog({ timestamp: Date.now(), level: 'debug', message, context: sanitized });
    }
  },

  info(message: string, context?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVEL.INFO) {
      const sanitized = context ? redactSensitive(context) : undefined;
      const formatted = formatMessage(message, context);
      console.info(formatted);
      pushLog({ timestamp: Date.now(), level: 'info', message, context: sanitized });
    }
  },

  warn(message: string, context?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVEL.WARN) {
      const sanitized = context ? redactSensitive(context) : undefined;
      const formatted = formatMessage(message, context);
      console.warn(formatted);
      pushLog({ timestamp: Date.now(), level: 'warn', message, context: sanitized });
    }
  },

  error(message: string, context?: Record<string, unknown>): void {
    if (currentLevel <= LOG_LEVEL.ERROR) {
      const sanitized = context ? redactSensitive(context) : undefined;
      const formatted = formatMessage(message, context);
      console.error(formatted);
      pushLog({ timestamp: Date.now(), level: 'error', message, context: sanitized });
    }
  },

  /** 导出完整日志缓冲（用于诊断） */
  getLogBuffer(): readonly LogEntry[] {
    return logBuffer;
  },

  /** 清空日志缓冲 */
  clearBuffer(): void {
    logBuffer.length = 0;
  },
} as const;
