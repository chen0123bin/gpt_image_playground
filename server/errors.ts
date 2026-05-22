export interface HttpError extends Error {
  status: number
  code: string
}

/** 创建可由 HTTP 层稳定序列化的错误对象。 */
export function createHttpError(status: number, code: string, message: string): HttpError {
  const error = new Error(message) as HttpError
  error.status = status
  error.code = code
  return error
}

/** 清洗错误消息中的敏感请求头，避免 API Key 写入响应或日志。 */
export function normalizeErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value)
  return raw
    .replace(/Authorization:\s*Bearer\s+[^\r\n]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/Cookie:\s*[^\r\n]+/gi, 'Cookie: [redacted]')
}

/** 将未知错误转换为 HTTP 层可使用的状态码、错误码和消息。 */
export function toHttpError(value: unknown): HttpError {
  if (value && typeof value === 'object' && 'status' in value && 'code' in value) {
    return value as HttpError
  }
  return createHttpError(500, 'INTERNAL_ERROR', normalizeErrorMessage(value))
}
