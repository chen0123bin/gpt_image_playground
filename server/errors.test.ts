import { describe, expect, it } from 'vitest'
import { createHttpError, normalizeErrorMessage, toHttpError } from './errors.js'

describe('server error helpers', () => {
  it('创建带状态码和错误码的错误', () => {
    const error = createHttpError(400, 'VALIDATION_ERROR', '缺少 API Key')

    expect(error.status).toBe(400)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toBe('缺少 API Key')
  })

  it('清洗 Authorization 和 Cookie 内容', () => {
    const message = normalizeErrorMessage('Authorization: Bearer sk-test\nCookie: a=b\n真实错误')

    expect(message).not.toContain('sk-test')
    expect(message).not.toContain('a=b')
    expect(message).toContain('真实错误')
  })

  it('将未知错误转换为内部错误', () => {
    const error = toHttpError(new Error('真实错误'))

    expect(error.status).toBe(500)
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.message).toBe('真实错误')
  })
})
