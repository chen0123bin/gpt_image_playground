import { describe, expect, it } from 'vitest'
import { buildUpstreamApiUrl, normalizeBaseUrl } from './url.js'

describe('server url helpers', () => {
  it('规范化没有协议的 API 地址', () => {
    expect(normalizeBaseUrl('api.example.com')).toBe('https://api.example.com')
  })

  it('保留并截断到 v1 路径', () => {
    expect(normalizeBaseUrl('https://api.example.com/openai/v1/images')).toBe('https://api.example.com/openai/v1')
  })

  it('为不含 v1 的地址补齐 v1', () => {
    expect(buildUpstreamApiUrl('https://api.example.com', 'images/generations')).toBe(
      'https://api.example.com/v1/images/generations',
    )
  })

  it('为已含 v1 的地址直接拼接 endpoint', () => {
    expect(buildUpstreamApiUrl('https://api.example.com/v1', 'responses')).toBe(
      'https://api.example.com/v1/responses',
    )
  })
})
