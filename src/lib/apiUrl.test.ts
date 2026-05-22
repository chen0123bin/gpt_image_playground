import { describe, expect, it } from 'vitest'
import { buildDirectApiUrl, buildServerOpenAIUrl, normalizeBaseUrl } from './apiUrl'

describe('apiUrl', () => {
  it('规范化 API Base URL', () => {
    expect(normalizeBaseUrl('api.example.com/v1/images')).toBe('https://api.example.com/v1')
  })

  it('拼接直连上游 URL', () => {
    expect(buildDirectApiUrl('https://api.example.com', 'responses')).toBe('https://api.example.com/v1/responses')
  })

  it('拼接服务端 API URL', () => {
    expect(buildServerOpenAIUrl('images/generations')).toBe('/api/openai-compatible/images/generations')
  })
})
