import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './http.js'
import { createNodeServer } from './index.js'

const tempStaticDirs: string[] = []

const requestBody = {
  profile: {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-image-2',
    apiMode: 'images' as const,
    timeout: 600,
  },
  prompt: 'prompt',
  params: {
    size: '1024x1024',
    quality: 'auto' as const,
    output_format: 'png' as const,
    output_compression: null,
    moderation: 'auto' as const,
    n: 1,
  },
  inputImageDataUrls: [],
}

/** 创建测试用 app，避免每个用例重复配置。 */
function createTestApp(staticDir = 'dist') {
  return createApp({ staticDir, defaultApiUrl: 'https://api.openai.com/v1' })
}

/** 等待指定毫秒，用于测试 Node 客户端断连后的异步事件传播。 */
function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 启动测试用 Node server，并返回端口与关闭函数。 */
function listenTestServer(server: Server) {
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('测试服务器地址无效'))
        return
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) closeReject(error)
            else closeResolve()
          })
        }),
      })
    })
  })
}

/** 发送测试 HTTP 请求，并收集 Node 客户端收到的响应。 */
function requestTestServer(port: number) {
  return new Promise<{ statusCode: number | undefined; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** 创建临时静态目录，并写入默认 SPA 入口文件。 */
async function createStaticDir(files: Record<string, string | Uint8Array> = {}) {
  const staticDir = await mkdtemp(join(tmpdir(), 'gpt-image-http-'))
  tempStaticDirs.push(staticDir)
  await writeFile(join(staticDir, 'index.html'), '<main>SPA fallback</main>')

  for (const [name, content] of Object.entries(files)) {
    const filePath = join(staticDir, name)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }

  return staticDir
}

describe('server http app', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(tempStaticDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('处理 OpenAI 兼容接口生成请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const app = createTestApp()

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }))

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations')
    await expect(response.json()).resolves.toMatchObject({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
  })

  it('按路由映射 edits 和 responses 端点', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'ZWRpdA==' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{ type: 'image_generation_call', result: 'cmVzcG9uc2U=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const app = createTestApp()

    const editResponse = await app.fetch(new Request('http://localhost/api/openai-compatible/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...requestBody,
        inputImageDataUrls: ['data:image/png;base64,AQID'],
      }),
    }))
    const responsesResponse = await app.fetch(new Request('http://localhost/api/openai-compatible/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...requestBody,
        profile: { ...requestBody.profile, apiMode: 'responses' as const },
      }),
    }))

    expect(editResponse.status).toBe(200)
    expect(responsesResponse.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/edits')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/responses')
  })

  it('拒绝未知 API 路径', async () => {
    const app = createTestApp()

    const response = await app.fetch(new Request('http://localhost/api/unknown', { method: 'POST' }))
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(payload.error.code).toBe('NOT_FOUND')
  })

  it('未知 OpenAI 兼容端点优先返回 404', async () => {
    const app = createTestApp()

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/not-real'))
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(payload.error.code).toBe('NOT_FOUND')
  })

  it('拒绝非 POST 的 OpenAI 兼容接口请求', async () => {
    const app = createTestApp()

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/images/generations'))
    const payload = await response.json()

    expect(response.status).toBe(405)
    expect(payload.error.code).toBe('METHOD_NOT_ALLOWED')
  })

  it('无效 JSON 返回稳定错误', async () => {
    const app = createTestApp()

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }))
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.error).toEqual({
      message: '请求 JSON 格式无效',
      code: 'INVALID_JSON',
      status: 400,
    })
  })

  it('错误响应不会泄露 Authorization 内容', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Authorization: Bearer sk-secret\n上游失败'))
    const app = createTestApp()

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }))
    const payload = await response.json()

    expect(response.status).toBe(502)
    expect(JSON.stringify(payload)).not.toContain('sk-secret')
    expect(payload.error.message).toContain('Authorization: Bearer [redacted]')
  })

  it('HTTP JSON 错误出口会清洗已成型错误对象', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue({
      status: 502,
      code: 'UPSTREAM_ERROR',
      message: 'Authorization: Bearer sk-secret\n上游失败',
    })
    const app = createTestApp()

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }))
    const payload = await response.json()

    expect(response.status).toBe(502)
    expect(JSON.stringify(payload)).not.toContain('sk-secret')
    expect(payload.error.message).toContain('Authorization: Bearer [redacted]')
  })

  it('服务静态文件并为 SPA 路由回退到 index.html', async () => {
    const staticDir = await createStaticDir({ 'assets/app.js': 'console.log("ok")' })
    const app = createTestApp(staticDir)

    const assetResponse = await app.fetch(new Request('http://localhost/assets/app.js'))
    const fallbackResponse = await app.fetch(new Request('http://localhost/app/settings'))

    expect(assetResponse.status).toBe(200)
    expect(assetResponse.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8')
    await expect(assetResponse.text()).resolves.toBe('console.log("ok")')
    expect(fallbackResponse.status).toBe(200)
    expect(fallbackResponse.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    await expect(fallbackResponse.text()).resolves.toBe('<main>SPA fallback</main>')
  })

  it('静态文件路径穿越不会读取目录外文件', async () => {
    const staticDir = await createStaticDir()
    await writeFile(join(staticDir, '..', 'secret.txt'), 'secret')
    const app = createTestApp(staticDir)

    const response = await app.fetch(new Request('http://localhost/%2e%2e/secret.txt'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    await expect(response.text()).resolves.toBe('<main>SPA fallback</main>')
  })

  it('Node 桥接在客户端断开时取消 Web Request', async () => {
    let abortCount = 0
    let seenRequest: () => void
    const requestSeen = new Promise<void>((resolve) => {
      seenRequest = resolve
    })
    const server = createNodeServer({
      fetch: async (request) => {
        request.signal.addEventListener('abort', () => {
          abortCount += 1
        }, { once: true })
        seenRequest()
        await delay(80)
        return new Response('late')
      },
    })
    const { port, close } = await listenTestServer(server)

    try {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/', method: 'POST' })
      req.on('error', () => undefined)
      req.end('body')
      await requestSeen
      req.destroy()
      await delay(50)

      expect(abortCount).toBe(1)
    } finally {
      await close()
    }
  })

  it('Node 桥接在响应关闭且未写完时取消 Web Request', async () => {
    let abortCount = 0
    let seenRequest: () => void
    const requestSeen = new Promise<void>((resolve) => {
      seenRequest = resolve
    })
    const server = createNodeServer({
      fetch: async (request) => {
        request.signal.addEventListener('abort', () => {
          abortCount += 1
        }, { once: true })
        seenRequest()
        await delay(80)
        return new Response('late')
      },
    })
    const { port, close } = await listenTestServer(server)

    try {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/' })
      req.on('error', () => undefined)
      req.end()
      await requestSeen
      req.destroy()
      await delay(50)

      expect(abortCount).toBe(1)
    } finally {
      await close()
    }
  })

  it('Node 桥接在响应中途关闭时取消 Web Request', async () => {
    let abortCount = 0
    let pushNextChunk: () => void
    const nextChunk = new Promise<void>((resolve) => {
      pushNextChunk = resolve
    })
    const server = createNodeServer({
      fetch: (request) => {
        request.signal.addEventListener('abort', () => {
          abortCount += 1
        }, { once: true })
        return Promise.resolve(new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('first'))
            await nextChunk
            controller.enqueue(new TextEncoder().encode('second'))
            controller.close()
          },
        })))
      },
    })
    const { port, close } = await listenTestServer(server)

    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
          res.once('data', () => {
            req.destroy()
            setTimeout(resolve, 50)
          })
        })
        req.on('error', () => undefined)
        req.end()
        setTimeout(() => reject(new Error('未收到首个响应块')), 1000)
      })

      expect(abortCount).toBe(1)
    } finally {
      pushNextChunk()
      await close()
    }
  })

  it('Node 桥接写入失败时取消 Web 响应 body', async () => {
    let cancelCount = 0
    let resolveCancel: () => void
    const canceled = new Promise<void>((resolve) => {
      resolveCancel = resolve
    })
    const server = createNodeServer({
      fetch: () => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'))
        },
        cancel() {
          cancelCount += 1
          resolveCancel()
        },
      }))),
    })
    const { port, close } = await listenTestServer(server)

    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
          res.once('data', () => {
            req.destroy()
            setTimeout(resolve, 50)
          })
        })
        req.on('error', () => undefined)
        req.end()
        setTimeout(() => reject(new Error('未收到首个响应块')), 1000)
      })

      await canceled

      expect(cancelCount).toBe(1)
    } finally {
      await close()
    }
  })

  it('Node 桥接在等待下一块响应时客户端断开会取消 Web 响应 body', async () => {
    let resolveCancel: () => void
    const canceled = new Promise<void>((resolve) => {
      resolveCancel = resolve
    })
    const server = createNodeServer({
      fetch: () => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'))
        },
        cancel() {
          resolveCancel()
        },
      }))),
    })
    const { port, close } = await listenTestServer(server)

    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        })
        req.on('error', () => undefined)
        req.end()
        const timeoutId = setTimeout(() => reject(new Error('未收到首个响应块')), 1000)
        canceled.then(() => clearTimeout(timeoutId), () => clearTimeout(timeoutId))
      })

      await Promise.race([
        canceled,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('响应 body 未被取消')), 1000)
        }),
      ])
    } finally {
      await close()
    }
  })

  it('Node 桥接保留多个 Set-Cookie 响应头', async () => {
    const headers = new Headers()
    headers.append('Set-Cookie', 'a=1; Path=/')
    headers.append('Set-Cookie', 'b=2; Path=/')
    const server = createNodeServer({
      fetch: () => new Response('ok', { headers }),
    })
    const { port, close } = await listenTestServer(server)

    try {
      const response = await requestTestServer(port)

      expect(response.statusCode).toBe(200)
      expect(response.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/'])
      expect(response.body).toBe('ok')
    } finally {
      await close()
    }
  })
})
