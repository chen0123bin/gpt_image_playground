import type { ApiProfile } from '../types'
import { buildServerOpenAIUrl } from './apiUrl'
import { imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'
import {
  type CallApiOptions,
  type CallApiResult,
  getApiErrorMessage,
} from './imageApiShared'

/** 将 Blob 转为可放入 JSON 请求体的 data URL。 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    // 分块拼接，避免大图片一次展开参数导致调用栈溢出。
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

/** 为服务端 API 准备输入图片，遮罩编辑时保证主图和遮罩都是 PNG data URL。 */
async function createServerRequestPayload(opts: CallApiOptions, profile: ApiProfile) {
  const inputImageDataUrls = [...opts.inputImageDataUrls]
  let maskDataUrl = opts.maskDataUrl ?? null

  if (opts.maskDataUrl) {
    inputImageDataUrls[0] = await blobToDataUrl(await imageDataUrlToPngBlob(inputImageDataUrls[0]))
    maskDataUrl = await blobToDataUrl(await maskDataUrlToPngBlob(opts.maskDataUrl))
  }

  return {
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImageDataUrls,
    maskDataUrl,
  }
}

/** 调用同源后端的 OpenAI 兼容图片 API。 */
export async function callServerOpenAICompatibleImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const path = profile.apiMode === 'responses'
    ? 'responses'
    : opts.inputImageDataUrls.length > 0
      ? 'images/edits'
      : 'images/generations'
  const response = await fetch(buildServerOpenAIUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(await createServerRequestPayload(opts, profile)),
  })

  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response))
  }

  return response.json() as Promise<CallApiResult>
}
