import { afterEach, describe, expect, it, vi } from 'vitest'
import { readServerConfig } from './config.js'

describe('readServerConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('读取默认监听配置和静态目录', () => {
    const config = readServerConfig()

    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(8788)
    expect(config.staticDir).toBe('dist')
    expect(config.defaultApiUrl).toBe('https://api.openai.com/v1')
  })

  it('从环境变量读取端口和默认 API 地址', () => {
    vi.stubEnv('HOST', '127.0.0.1')
    vi.stubEnv('PORT', '28080')
    vi.stubEnv('STATIC_DIR', 'public-build')
    vi.stubEnv('DEFAULT_API_URL', 'https://api.example.com/v1')

    const config = readServerConfig()

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 28080,
      staticDir: 'public-build',
      defaultApiUrl: 'https://api.example.com/v1',
    })
  })
})
