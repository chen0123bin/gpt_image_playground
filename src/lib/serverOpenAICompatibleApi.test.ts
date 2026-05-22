import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { callServerOpenAICompatibleImageApi } from './serverOpenAICompatibleApi'

vi.mock('./canvasImage', () => ({
  imageDataUrlToPngBlob: vi.fn(async () => new Blob(['main-png'], { type: 'image/png' })),
  maskDataUrlToPngBlob: vi.fn(async () => new Blob(['mask-png'], { type: 'image/png' })),
}))

describe('callServerOpenAICompatibleImageApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('向同源后端发送 Images API 生成请求并返回图片', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,aW1hZ2U='],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await callServerOpenAICompatibleImageApi({
      settings: {} as any,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultOpenAIProfile({ apiKey: 'key', apiMode: 'images' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/openai-compatible/images/generations', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }))
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
  })

  it('有输入图片时向同源后端发送 Images API 编辑请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,ZWRpdA=='],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await callServerOpenAICompatibleImageApi({
      settings: {} as any,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: ['data:image/jpeg;base64,aW1hZ2U='],
    }, createDefaultOpenAIProfile({ apiKey: 'key', apiMode: 'images' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/openai-compatible/images/edits', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }))
  })

  it('向同源后端发送 Responses API 请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,cmVzcG9uc2U='],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await callServerOpenAICompatibleImageApi({
      settings: {} as any,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultOpenAIProfile({ apiKey: 'key', apiMode: 'responses' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/openai-compatible/responses', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }))
  })

  it('遮罩编辑时把首张输入图和遮罩转成 PNG data URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,bWFzaw=='],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await callServerOpenAICompatibleImageApi({
      settings: {} as any,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [
        'data:image/jpeg;base64,bWFpbg==',
        'data:image/webp;base64,b3RoZXI=',
      ],
      maskDataUrl: 'data:image/webp;base64,bWFzaw==',
    }, createDefaultOpenAIProfile({ apiKey: 'key', apiMode: 'images' }))

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.inputImageDataUrls).toEqual([
      'data:image/png;base64,bWFpbi1wbmc=',
      'data:image/webp;base64,b3RoZXI=',
    ])
    expect(body.maskDataUrl).toBe('data:image/png;base64,bWFzay1wbmc=')
  })

  it('非 OK 响应抛出上游错误消息', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'upstream failed' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))

    await expect(callServerOpenAICompatibleImageApi({
      settings: {} as any,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultOpenAIProfile({ apiKey: 'key', apiMode: 'images' }))).rejects.toThrow('upstream failed')
  })
})
