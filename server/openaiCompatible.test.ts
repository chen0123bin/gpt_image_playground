import { afterEach, describe, expect, it, vi } from 'vitest'

const lookupMock = vi.hoisted(() => vi.fn())
const httpRequestMock = vi.hoisted(() => vi.fn())
const httpsRequestMock = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}))

vi.mock('node:http', () => ({
  request: httpRequestMock,
}))

vi.mock('node:https', () => ({
  request: httpsRequestMock,
}))

import { callOpenAICompatibleFromServer } from './openaiCompatible.js'

const baseRequest = {
  profile: {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-image-2',
    apiMode: 'images' as const,
    timeout: 600,
    codexCli: false,
    responseFormatB64Json: false,
  },
  prompt: '画一只玻璃杯',
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

describe('callOpenAICompatibleFromServer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    lookupMock.mockReset()
    httpRequestMock.mockReset()
    httpsRequestMock.mockReset()
  })

  /** 模拟 Node http/https.request 的图片响应，便于测试安全下载分支。 */
  const mockImageRequest = (
    requestMock: ReturnType<typeof vi.fn>,
    body = new Uint8Array([1, 2, 3]),
    headers: Record<string, string> = { 'content-type': 'image/png' },
    statusCode = 200,
  ) => {
    requestMock.mockImplementation((_url, _options, callback) => {
      const listeners = new Map<string, (...args: any[]) => void>()
      const requestListeners = new Map<string, (...args: any[]) => void>()
      const response = {
        statusCode,
        headers,
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          listeners.set(event, handler)
          return response
        }),
        resume: vi.fn(),
      }
      callback(response)
      queueMicrotask(() => {
        listeners.get('data')?.(Buffer.from(body))
        listeners.get('end')?.()
      })
      const request = {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          requestListeners.set(event, handler)
          return request
        }),
        destroy: vi.fn((error?: Error) => {
          if (error) queueMicrotask(() => requestListeners.get('error')?.(error))
        }),
        end: vi.fn(),
      }
      return request
    })
  }

  it('拒绝缺少 API Key 的请求', async () => {
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiKey: '' },
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
  })

  it('拒绝畸形请求并稳定返回校验错误', async () => {
    await expect(callOpenAICompatibleFromServer(null as any)).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      params: { ...baseRequest.params, size: '' },
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      inputImageDataUrls: 'data:image/png;base64,AQID' as any,
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, baseUrl: 123 as any },
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      params: { ...baseRequest.params, n: 1.5 },
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      params: { ...baseRequest.params, n: 0 },
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      params: { ...baseRequest.params, n: 11 },
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      inputImageDataUrls: ['data:image/png,%E0%A4%A'],
    }, 'images/edits')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
  })

  it('调用 Images API 并返回 base64 图片', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=', revised_prompt: '玻璃杯' }],
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callOpenAICompatibleFromServer(baseRequest)
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    )
    expect(requestBody).toEqual({
      model: 'gpt-image-2',
      prompt: '画一只玻璃杯',
      size: '1024x1024',
      output_format: 'png',
      moderation: 'auto',
      quality: 'auto',
    })
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(result.revisedPrompts).toEqual(['玻璃杯'])
    expect(result.actualParams).toEqual({
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
    })
  })

  it('Images API 传递 output_compression 和 response_format', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, responseFormatB64Json: true },
      params: { ...baseRequest.params, output_format: 'webp', output_compression: 80 },
    })
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)

    expect(requestBody.output_compression).toBe(80)
    expect(requestBody.response_format).toBe('b64_json')
  })

  it('调用 Responses API 并解析 image_generation_call 结果', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', result: 'cmVzcG9uc2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiMode: 'responses' },
    })
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/responses')
    expect(requestBody).toMatchObject({
      model: 'gpt-image-2',
      input: 'Use the following text as the complete prompt. Do not rewrite it:\n画一只玻璃杯',
      tool_choice: 'required',
    })
    expect(requestBody.tools).toEqual([expect.objectContaining({
      type: 'image_generation',
      action: 'generate',
      size: '1024x1024',
      output_format: 'png',
    })])
    expect(result.images).toEqual(['data:image/png;base64,cmVzcG9uc2U='])
  })

  it('Responses API 有输入图时发送 edit action、input_image 和 mask', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        result: 'cmVzcG9uc2U=',
        revised_prompt: '改写提示词',
        size: '1024x1024',
        quality: 'high',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiMode: 'responses' },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      maskDataUrl: 'data:image/png;base64,BAUG',
    })
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)

    expect(requestBody.input[0].content).toEqual([
      { type: 'input_text', text: 'Use the following text as the complete prompt. Do not rewrite it:\n画一只玻璃杯' },
      { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
    ])
    expect(requestBody.tools).toEqual([expect.objectContaining({
      type: 'image_generation',
      action: 'edit',
      input_image_mask: { image_url: 'data:image/png;base64,BAUG' },
    })])
    expect(result.actualParamsList).toEqual([{ size: '1024x1024', quality: 'high' }])
    expect(result.revisedPrompts).toEqual(['改写提示词'])
  })

  it('由后端下载上游返回的域名图片 URL 并转为 data URL', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockImageRequest(httpsRequestMock)
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: 'https://cdn.example.com/image.png' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const result = await callOpenAICompatibleFromServer(baseRequest)
    const requestOptions = httpsRequestMock.mock.calls[0][1]

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lookupMock).toHaveBeenCalledWith('cdn.example.com', { all: true })
    expect(httpsRequestMock.mock.calls[0][0]).toBeInstanceOf(URL)
    expect(httpsRequestMock.mock.calls[0][0].hostname).toBe('cdn.example.com')
    expect(requestOptions.servername).toBe('cdn.example.com')
    expect(requestOptions.headers.Host).toBe('cdn.example.com')
    await expect(new Promise((resolve, reject) => requestOptions.lookup('cdn.example.com', {}, (err: Error | null, address: string) => err ? reject(err) : resolve(address)))).resolves.toBe('93.184.216.34')
    await expect(new Promise((resolve, reject) => requestOptions.lookup('cdn.example.com', { all: true }, (err: Error | null, addresses: Array<{ address: string; family: number }>) => err ? reject(err) : resolve(addresses)))).resolves.toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(result.images).toEqual(['data:image/png;base64,AQID'])
    expect(result.rawImageUrls).toEqual(['https://cdn.example.com/image.png'])
  })

  it('拒绝重定向到内网地址的图片 URL', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockImageRequest(httpsRequestMock, new Uint8Array(), { location: 'http://127.0.0.1/image.png' }, 302)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'https://cdn.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })
    expect(httpsRequestMock).toHaveBeenCalledTimes(1)
  })

  it('拒绝下载内网和 metadata 图片 URL', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://private.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })

    vi.restoreAllMocks()
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://metadata.example.com/latest/meta-data' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })

    vi.restoreAllMocks()
    lookupMock.mockResolvedValue([{ address: '100.64.0.1', family: 4 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://carrier-nat.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })

    vi.restoreAllMocks()
    lookupMock.mockResolvedValue([{ address: '198.18.0.1', family: 4 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://benchmark.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })

    vi.restoreAllMocks()
    lookupMock.mockResolvedValue([{ address: '::ffff:7f00:1', family: 6 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://mapped-loopback.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })

    vi.restoreAllMocks()
    lookupMock.mockResolvedValue([{ address: '::ffff:c0a8:1', family: 6 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://mapped-private.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })

    vi.restoreAllMocks()
    lookupMock.mockResolvedValue([{ address: '::ffff:ac10:1', family: 6 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://mapped-private-2.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })
  })

  it('DNS 解析失败会稳定包装为上游错误', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND cdn.example.com'), { code: 'ENOTFOUND' }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'https://cdn.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })
  })

  it('DNS 解析超时会返回请求超时', async () => {
    vi.useFakeTimers()
    lookupMock.mockImplementation(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new DOMException('请求超时', 'TimeoutError')), 1000)
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'https://cdn.example.com/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const promise = callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, timeout: 1 },
    })
    const expectation = expect(promise).rejects.toMatchObject({
      status: 504,
      code: 'UPSTREAM_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(1000)
    await expectation
  })

  it('拒绝下载非图片 Content-Type 和过大的图片响应', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockImageRequest(httpRequestMock, Buffer.from('<html></html>'), { 'content-type': 'text/html' })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: 'http://93.184.216.34/page.html' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })

    vi.restoreAllMocks()
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockImageRequest(httpRequestMock, new Uint8Array([1, 2, 3]), {
      'content-type': 'image/png',
      'content-length': String(26 * 1024 * 1024),
    })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: 'http://93.184.216.34/huge.png' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })
  })

  it('上游请求超时后返回明确错误', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))

    const promise = callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, timeout: 1 },
    })
    const expectation = expect(promise).rejects.toThrow('请求超时')

    await vi.advanceTimersByTimeAsync(1000)
    await expectation
  })

  it('超时时间会限制在 1 到 900 秒', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      signal?.addEventListener('abort', () => reject(signal.reason))
    }))

    const fastPromise = callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, timeout: 0 },
    })
    const fastExpectation = expect(fastPromise).rejects.toMatchObject({
      status: 504,
      code: 'UPSTREAM_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(1000)
    await fastExpectation

    vi.restoreAllMocks()
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      signal?.addEventListener('abort', () => reject(signal.reason))
    }))

    const slowPromise = callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, timeout: 9999 },
    })
    const slowExpectation = expect(slowPromise).rejects.toMatchObject({
      status: 504,
      code: 'UPSTREAM_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(899_000)
    await Promise.resolve()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await slowExpectation
  })

  it('外层 signal 已取消时不发起上游请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const controller = new AbortController()
    controller.abort()

    await expect(callOpenAICompatibleFromServer(baseRequest, undefined, controller.signal)).rejects.toMatchObject({
      status: 499,
      code: 'REQUEST_ABORTED',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('2xx 非 JSON 响应包装为不可识别上游响应', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_UPSTREAM_RESPONSE',
    })
  })

  it('读取 2xx JSON 期间 abort 会按取消分类', async () => {
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => {
        controller.abort()
        throw new DOMException('Aborted', 'AbortError')
      },
    } as Response)

    await expect(callOpenAICompatibleFromServer(baseRequest, undefined, controller.signal)).rejects.toMatchObject({
      status: 499,
      code: 'REQUEST_ABORTED',
    })
  })

  it('图片下载取消时不会泄漏原始 AbortError', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    httpRequestMock.mockImplementation((_url, _options, callback) => {
      const requestListeners = new Map<string, (...args: any[]) => void>()
      const response = {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        on: vi.fn(),
        resume: vi.fn(),
      }
      callback(response)
      const request = {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          requestListeners.set(event, handler)
          return request
        }),
        destroy: vi.fn((error?: Error) => {
          if (error) queueMicrotask(() => requestListeners.get('error')?.(error))
        }),
        end: vi.fn(),
      }
      return request
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://93.184.216.34/image.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const controller = new AbortController()

    const promise = callOpenAICompatibleFromServer(baseRequest, undefined, controller.signal)
    const expectation = expect(promise).rejects.toMatchObject({
      status: 499,
      code: 'REQUEST_ABORTED',
    })
    await Promise.resolve()
    controller.abort()
    await expectation
  })

  it('非 2xx 纯文本错误体不会因重复读取丢失消息', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream plain error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
      message: 'upstream plain error',
    })
  })

  it('编辑图片时调用 images/edits 并提交 multipart 图片字段', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'ZWRpdA==' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callOpenAICompatibleFromServer({
      ...baseRequest,
      inputImageDataUrls: ['data:image/png;base64,AQID'],
    }, 'images/edits')
    const body = fetchMock.mock.calls[0][1]?.body as FormData

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/edits')
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('model')).toBe('gpt-image-2')
    expect(body.get('prompt')).toBe('画一只玻璃杯')
    expect(body.getAll('image[]')).toHaveLength(1)
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Authorization: 'Bearer test-key',
    })
    expect(result.images).toEqual(['data:image/png;base64,ZWRpdA=='])
  })

  it('编辑图片带 mask 时只接受 PNG 主图和 PNG mask', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'ZWRpdA==' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callOpenAICompatibleFromServer({
      ...baseRequest,
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      maskDataUrl: 'data:image/png;base64,BAUG',
    }, 'images/edits')
    const body = fetchMock.mock.calls[0][1]?.body as FormData
    const image = body.get('image[]') as File
    const mask = body.get('mask') as File

    expect(image.name).toBe('input-1.png')
    expect(image.type).toBe('image/png')
    expect(mask.name).toBe('mask.png')
    expect(mask.type).toBe('image/png')

    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      inputImageDataUrls: ['data:image/jpeg;base64,AQID'],
      maskDataUrl: 'data:image/png;base64,BAUG',
    }, 'images/edits')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })

    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      maskDataUrl: 'data:image/webp;base64,BAUG',
    }, 'images/edits')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })

    const largeDataUrl = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      inputImageDataUrls: Array.from({ length: 513 }, () => largeDataUrl),
    }, 'images/edits')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
  })

  it('Responses API 多图拆成并发单图请求并合并结果', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'MQ==',
          revised_prompt: '一',
          quality: 'auto',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'Mg==',
          revised_prompt: '二',
          size: '1024x1024',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const result = await callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiMode: 'responses' },
      params: { ...baseRequest.params, n: 2 },
    })
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/responses')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/responses')
    expect(firstBody.tools[0]).not.toHaveProperty('n')
    expect(secondBody.tools[0]).not.toHaveProperty('n')
    expect(result.images).toEqual(['data:image/png;base64,MQ==', 'data:image/png;base64,Mg=='])
    expect(result.actualParams).toEqual({ quality: 'auto', n: 2 })
    expect(result.actualParamsList).toEqual([{ quality: 'auto' }, { size: '1024x1024' }])
    expect(result.revisedPrompts).toEqual(['一', '二'])
  })

  it('Responses API 有输入图和 mask 时校验 payload 大小', async () => {
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiMode: 'responses' },
      inputImageDataUrls: [`data:image/png;base64,${'A'.repeat(68 * 1024 * 1024)}`],
      maskDataUrl: 'data:image/png;base64,AQID',
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })

    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiMode: 'responses' },
      inputImageDataUrls: ['data:image/png;base64,AQID'],
      maskDataUrl: `data:image/png;base64,${'A'.repeat(68 * 1024 * 1024)}`,
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
  })

  it('codexCli 多图 Images API 拆成并发单图请求并合并结果', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockImageRequest(httpRequestMock, new Uint8Array([2]))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'MQ==', revised_prompt: '一' }],
        quality: 'auto',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: 'http://93.184.216.34/two.png', revised_prompt: '二' }],
        size: '1024x1024',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }))

    const result = await callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, codexCli: true },
      params: { ...baseRequest.params, n: 2, quality: 'high' },
    })
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/images/generations')
    expect(firstBody).not.toHaveProperty('n')
    expect(secondBody).not.toHaveProperty('n')
    expect(firstBody).not.toHaveProperty('quality')
    expect(firstBody.prompt).toBe('Use the following text as the complete prompt. Do not rewrite it:\n画一只玻璃杯')
    expect(result.images).toEqual(['data:image/png;base64,MQ==', 'data:image/png;base64,Ag=='])
    expect(result.actualParams).toEqual({ quality: 'auto', n: 2 })
    expect(result.actualParamsList).toEqual([{ quality: 'auto' }, { size: '1024x1024' }])
    expect(result.revisedPrompts).toEqual(['一', '二'])
    expect(result.rawImageUrls).toEqual(['http://93.184.216.34/two.png'])
  })

  it('图片下载流式超限会触发 request error 并结束', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockImageRequest(httpRequestMock, new Uint8Array(26 * 1024 * 1024), { 'content-type': 'image/png' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ url: 'http://93.184.216.34/stream-huge.png' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callOpenAICompatibleFromServer(baseRequest)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
    })
  })
})
