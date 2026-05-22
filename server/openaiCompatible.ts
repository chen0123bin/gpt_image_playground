import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import { createHttpError, normalizeErrorMessage } from './errors.js'
import { buildUpstreamApiUrl } from './url.js'

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

const MIME_MAP: Record<ServerOpenAIRequest['params']['output_format'], string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024
const MAX_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_REDIRECTS = 3

type OpenAICompatibleEndpoint = 'images/generations' | 'images/edits' | 'responses'

export interface ServerApiProfile {
  baseUrl: string
  apiKey: string
  model: string
  apiMode: 'images' | 'responses'
  timeout: number
  codexCli?: boolean
  responseFormatB64Json?: boolean
}

export interface ServerOpenAIRequest {
  profile: ServerApiProfile
  prompt: string
  params: {
    size: string
    quality: 'auto' | 'low' | 'medium' | 'high'
    output_format: 'png' | 'jpeg' | 'webp'
    output_compression: number | null
    moderation: 'auto' | 'low'
    n: number
  }
  inputImageDataUrls: string[]
  maskDataUrl?: string | null
}

export interface ServerOpenAIResult {
  images: string[]
  actualParams?: Partial<ServerOpenAIRequest['params']>
  actualParamsList?: Array<Partial<ServerOpenAIRequest['params']> | undefined>
  revisedPrompts?: Array<string | undefined>
  rawImageUrls?: string[]
}

interface TimeoutRequestSignal {
  signal: AbortSignal
  cleanup: () => void
}

interface SafeResolvedAddress {
  address: string
  family: 4 | 6
}

/** 校验服务端 OpenAI 兼容接口请求的必填字段。 */
export function validateServerOpenAIRequest(input: ServerOpenAIRequest): void {
  if (!isRecord(input)) throw createHttpError(400, 'VALIDATION_ERROR', '请求体格式无效')
  if (!isRecord(input.profile)) throw createHttpError(400, 'VALIDATION_ERROR', '缺少 API 配置')
  if (typeof input.profile.baseUrl !== 'string' || !input.profile.baseUrl.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少 API URL')
  if (typeof input.profile.apiKey !== 'string' || !input.profile.apiKey.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少 API Key')
  if (typeof input.profile.model !== 'string' || !input.profile.model.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少模型 ID')
  if (input.profile.apiMode !== 'images' && input.profile.apiMode !== 'responses') throw createHttpError(400, 'VALIDATION_ERROR', 'apiMode 格式无效')
  if (!Number.isFinite(input.profile.timeout)) throw createHttpError(400, 'VALIDATION_ERROR', 'timeout 格式无效')
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少提示词')
  if (!isRecord(input.params)) throw createHttpError(400, 'VALIDATION_ERROR', '缺少生成参数')
  if (typeof input.params.size !== 'string' || !input.params.size.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少图片尺寸')
  if (input.params.quality !== 'auto' && input.params.quality !== 'low' && input.params.quality !== 'medium' && input.params.quality !== 'high') {
    throw createHttpError(400, 'VALIDATION_ERROR', 'quality 格式无效')
  }
  if (input.params.output_format !== 'png' && input.params.output_format !== 'jpeg' && input.params.output_format !== 'webp') {
    throw createHttpError(400, 'VALIDATION_ERROR', 'output_format 格式无效')
  }
  if (input.params.output_compression !== null && typeof input.params.output_compression !== 'number') throw createHttpError(400, 'VALIDATION_ERROR', 'output_compression 格式无效')
  if (input.params.moderation !== 'auto' && input.params.moderation !== 'low') throw createHttpError(400, 'VALIDATION_ERROR', 'moderation 格式无效')
  if (!Number.isInteger(input.params.n) || input.params.n <= 0 || input.params.n > 10) throw createHttpError(400, 'VALIDATION_ERROR', 'n 必须是 1 到 10 的整数')
  if (!Array.isArray(input.inputImageDataUrls)) throw createHttpError(400, 'VALIDATION_ERROR', '输入图片格式无效')
  if (!input.inputImageDataUrls.every((item) => typeof item === 'string' && item.startsWith('data:'))) {
    throw createHttpError(400, 'VALIDATION_ERROR', '输入图片必须为 data URL')
  }
  if (input.maskDataUrl != null && (typeof input.maskDataUrl !== 'string' || !input.maskDataUrl.startsWith('data:'))) {
    throw createHttpError(400, 'VALIDATION_ERROR', '遮罩必须为 data URL')
  }
}

/** 调用 OpenAI 兼容接口并返回前端可直接消费的图片结果。 */
export async function callOpenAICompatibleFromServer(
  input: ServerOpenAIRequest,
  endpoint?: OpenAICompatibleEndpoint,
  outerSignal?: AbortSignal,
): Promise<ServerOpenAIResult> {
  validateServerOpenAIRequest(input)
  const resolvedEndpoint = endpoint ?? (input.profile.apiMode === 'responses' ? 'responses' : 'images/generations')
  return resolvedEndpoint === 'responses'
    ? callResponsesApi(input, outerSignal)
    : callImagesApi(input, resolvedEndpoint, outerSignal)
}

/** 创建带超时的请求信号，并把外层取消同步到上游请求。 */
function createTimeoutSignal(timeoutSeconds: number, outerSignal?: AbortSignal): TimeoutRequestSignal {
  const controller = new AbortController()
  const timeoutMs = Math.min(Math.max(timeoutSeconds ?? 600, 1), 900) * 1000
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('请求超时', 'TimeoutError'))
  }, timeoutMs)

  const abortFromOuterSignal = () => {
    controller.abort(new DOMException('请求已取消', 'AbortError'))
  }
  if (outerSignal?.aborted) {
    abortFromOuterSignal()
  }
  outerSignal?.addEventListener('abort', abortFromOuterSignal, { once: true })

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId)
      outerSignal?.removeEventListener('abort', abortFromOuterSignal)
    },
  }
}

/** 判断未知值是否为普通对象，便于安全读取上游 JSON 字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 判断字符串是否为可由后端下载的 HTTP 图片地址。 */
function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

/** 判断字符串是否已经是 data URL。 */
function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

/** 将 base64 图片补齐为 data URL，兼容上游直接返回 data URL 的情况。 */
function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

/** 提取上游响应中的实际生效参数，只保留前端认识的字段。 */
function pickActualParams(source: unknown): Partial<ServerOpenAIRequest['params']> {
  if (!isRecord(source)) return {}
  const actualParams: Partial<ServerOpenAIRequest['params']> = {}

  if (typeof source.size === 'string') actualParams.size = source.size
  if (source.quality === 'auto' || source.quality === 'low' || source.quality === 'medium' || source.quality === 'high') {
    actualParams.quality = source.quality
  }
  if (source.output_format === 'png' || source.output_format === 'jpeg' || source.output_format === 'webp') {
    actualParams.output_format = source.output_format
  }
  if (typeof source.output_compression === 'number') actualParams.output_compression = source.output_compression
  if (source.moderation === 'auto' || source.moderation === 'low') actualParams.moderation = source.moderation
  if (typeof source.n === 'number') actualParams.n = source.n

  return actualParams
}

/** 合并实际生效参数，空对象会转为 undefined 以匹配前端现有结构。 */
function mergeActualParams(...sources: Array<Partial<ServerOpenAIRequest['params']> | undefined>) {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

/** 从上游错误响应中读取尽量友好的错误消息。 */
async function getUpstreamErrorMessage(response: Response): Promise<string> {
  let text = ''
  try {
    text = await response.text()
    const payload = text.trim() ? JSON.parse(text) : {}
    if (isRecord(payload.error) && typeof payload.error.message === 'string') return payload.error.message
    if (typeof payload.error === 'string') return payload.error
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) return payload.detail.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    if (typeof payload.message === 'string') return payload.message
  } catch {
    if (text.trim()) return text
  }
  return `HTTP ${response.status}`
}

/** 估算 data URL 编码后的大小，用于提前阻止过大的编辑输入。 */
function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

/** 估算 data URL 解码后的大小，用于遮罩编辑的单文件限制。 */
function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length
  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return safeDecodeURIComponent(payload).length
  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

/** 安全解码 URL 编码内容，畸形输入统一转为校验错误。 */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw createHttpError(400, 'VALIDATION_ERROR', 'data URL 内容格式无效')
  }
}

/** 读取 data URL 的 MIME 类型，格式错误时抛出校验错误。 */
function getDataUrlMimeType(dataUrl: string, fallbackType = 'image/png'): string {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) throw createHttpError(400, 'VALIDATION_ERROR', 'data URL 内容格式无效')
  const meta = dataUrl.slice(0, commaIndex)
  return /^data:([^;,]+)/.exec(meta)?.[1] ?? fallbackType
}

/** 校验编辑请求 payload 总大小，避免服务端接收不受限大请求。 */
function assertImageInputPayloadSize(bytes: number): void {
  if (bytes > MAX_IMAGE_INPUT_PAYLOAD_BYTES) {
    throw createHttpError(400, 'VALIDATION_ERROR', '图像输入有效负载总大小过大')
  }
}

/** 校验遮罩编辑单文件大小，与前端限制保持一致。 */
function assertMaskEditFileSize(label: string, bytes: number): void {
  if (bytes > MAX_MASK_EDIT_FILE_BYTES) {
    throw createHttpError(400, 'VALIDATION_ERROR', `${label}过大`)
  }
}

/** 校验含输入图或遮罩的 JSON 请求大小，复用前端图片输入限制。 */
function assertInputImagesPayload(input: ServerOpenAIRequest): void {
  const payloadSize = input.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
    (input.maskDataUrl ? getDataUrlEncodedByteSize(input.maskDataUrl) : 0)
  assertImageInputPayloadSize(payloadSize)
  if (input.maskDataUrl) {
    if (getDataUrlMimeType(input.inputImageDataUrls[0] ?? '') !== 'image/png' || getDataUrlMimeType(input.maskDataUrl) !== 'image/png') {
      throw createHttpError(400, 'VALIDATION_ERROR', '带遮罩编辑时主图和遮罩都必须是 PNG data URL')
    }
    assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(input.inputImageDataUrls[0] ?? ''))
    assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(input.maskDataUrl))
  }
}

/** 将 data URL 转为可放进 FormData 的 Blob。 */
function dataUrlToBlob(dataUrl: string, fallbackType = 'image/png', forcedType?: string): Blob {
  const [meta, payload = ''] = dataUrl.split(',', 2)
  const mime = forcedType ?? /^data:([^;,]+)/.exec(meta)?.[1] ?? fallbackType
  const bytes = /;base64/i.test(meta)
    ? Buffer.from(payload.replace(/\s/g, ''), 'base64')
    : Buffer.from(safeDecodeURIComponent(payload))
  return new Blob([bytes], { type: mime })
}

/** 将 Blob 内容转为 data URL。 */
async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = Buffer.from(await blob.arrayBuffer())
  return `data:${blob.type || fallbackMime};base64,${bytes.toString('base64')}`
}

/** 判断 IPv4 地址是否落入不允许服务端访问的特殊网段。 */
function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 198 && (b === 18 || b === 19) ||
    a === 192 && b === 168 ||
    a >= 224
}

/** 将简短 IPv4 十六进制片段补齐为点分十进制，供 IPv4-mapped IPv6 检查使用。 */
function hexIpv4ToDotted(value: string): string | null {
  const normalized = value.padStart(8, '0')
  if (!/^[0-9a-f]{8}$/i.test(normalized)) return null
  const bytes = normalized.match(/../g)?.map((item) => Number.parseInt(item, 16)) ?? []
  return bytes.length === 4 ? bytes.join('.') : null
}

/** 从 IPv4-mapped IPv6 地址中提取 IPv4 地址，兼容点分和十六进制写法。 */
function extractMappedIpv4(address: string): string | null {
  const mappedPrefix = '::ffff:'
  if (!address.startsWith(mappedPrefix)) return null
  const tail = address.slice(mappedPrefix.length)
  if (tail.includes('.')) return tail
  return hexIpv4ToDotted(tail.replace(/:/g, ''))
}

/** 判断 IPv6 地址是否落入本地、私有、链路本地、组播或未指定范围。 */
function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  const mappedIpv4 = extractMappedIpv4(normalized)
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4)

  // fe80::/10 包含 fe80 到 febf；fc00::/7 包含 fc 和 fd。
  const firstGroup = Number.parseInt(normalized.split(':')[0] || '0', 16)
  return normalized === '::' ||
    normalized === '::1' ||
    (firstGroup & 0xfe00) === 0xfc00 ||
    (firstGroup & 0xffc0) === 0xfe80 ||
    (firstGroup & 0xff00) === 0xff00
}

/** 校验并固定图片 URL 的解析结果，避免下载阶段发生 DNS rebinding。 */
async function resolveSafeImageUrl(url: URL, signal?: AbortSignal): Promise<SafeResolvedAddress> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 协议不受支持')
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!hostname) {
    throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 主机不允许访问')
  }
  const ipVersion = isIP(hostname)
  const addresses: SafeResolvedAddress[] = ipVersion
    ? [{ address: hostname, family: toAddressFamily(ipVersion) }]
    : (await lookupSafe(hostname, signal)).map((item) => ({
        address: item.address,
        family: item.family === 6 ? 6 : 4,
      }))

  if (!addresses.length || addresses.some((item) =>
    item.family === 4 ? isBlockedIpv4(item.address) : isBlockedIpv6(item.address),
  )) {
    throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 主机不允许访问')
  }

  return addresses[0]
}

/** 解析图片 URL 主机，DNS 失败统一包装为上游错误。 */
async function lookupSafe(hostname: string, signal?: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  if (signal?.aborted) wrapUpstreamError(signal.reason, signal)

  try {
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const abortLookup = () => reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'))
      signal?.addEventListener('abort', abortLookup, { once: true })
    })
    return await Promise.race([
      lookup(hostname, { all: true }),
      abortPromise,
    ])
  } catch (error) {
    if (signal?.aborted) wrapUpstreamError(error, signal)
    if (isAbortLikeError(error)) {
      const controller = new AbortController()
      controller.abort(error)
      wrapUpstreamError(error, controller.signal)
    }
    throw createHttpError(502, 'UPSTREAM_ERROR', normalizeErrorMessage(error))
  }
}

/** 将 Node isIP 返回值收窄为解析地址使用的 4/6 字面量类型。 */
function toAddressFamily(value: number): 4 | 6 {
  return value === 6 ? 6 : 4
}

/** 创建固定解析结果的 lookup 函数，避免 request 内部再次解析域名。 */
function createFixedLookup(resolved: SafeResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === 'object' && options != null && 'all' in options && options.all === true
    if (wantsAll) {
      ;(callback as (err: NodeJS.ErrnoException | null, addresses: SafeResolvedAddress[]) => void)(null, [resolved])
      return
    }
    ;(callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, resolved.address, resolved.family)
  }
}

/** 拼接 Host 请求头，保留原始端口信息。 */
function createHostHeader(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

/** 用 Node 原生 request 下载图片，固定 lookup 且保留原始域名用于 Host/TLS servername。 */
function requestImageBlob(url: URL, resolved: SafeResolvedAddress, signal?: AbortSignal): Promise<{
  blob?: Blob
  redirectLocation?: string
  statusCode: number
}> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settleReject = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const settleResolve = (value: { blob?: Blob; redirectLocation?: string; statusCode: number }) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      lookup: createFixedLookup(resolved),
      servername: url.hostname,
      headers: {
        Host: createHostHeader(url),
      },
    }, (response: IncomingMessage) => {
      const statusCode = response.statusCode ?? 0
      if (statusCode >= 300 && statusCode < 400) {
        response.resume()
        settleResolve({ statusCode, redirectLocation: typeof response.headers.location === 'string' ? response.headers.location : undefined })
        return
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        settleReject(createHttpError(502, 'UPSTREAM_ERROR', `图片 URL 下载失败：HTTP ${statusCode}`))
        return
      }

      const contentType = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() || ''
      if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
        response.resume()
        settleReject(createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 返回的 Content-Type 不是图片'))
        return
      }

      const contentLength = Number(response.headers['content-length'] || 0)
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_DOWNLOAD_BYTES) {
        response.resume()
        settleReject(createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 下载内容过大'))
        return
      }

      const chunks: Buffer[] = []
      let totalBytes = 0
      response.on('data', (chunk: Buffer) => {
        if (settled || request.destroyed) return
        totalBytes += chunk.length
        if (totalBytes > MAX_IMAGE_DOWNLOAD_BYTES) {
          settleReject(createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 下载内容过大'))
          request.destroy(createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 下载内容过大'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        settleResolve({
          statusCode,
          blob: new Blob([Buffer.concat(chunks)], { type: contentType || fallbackImageMimeFromUrl(url) }),
        })
      })
      response.on('error', settleReject)
    })

    request.on('error', settleReject)
    if (signal) {
      const abortRequest = () => {
        request.destroy(signal.reason instanceof Error ? signal.reason : new DOMException('请求已取消', 'AbortError'))
      }
      if (signal.aborted) {
        abortRequest()
      } else {
        signal.addEventListener('abort', abortRequest, { once: true })
      }
    }
    request.end()
  })
}

/** 根据 URL 后缀给缺失 Content-Type 的响应一个保守图片 MIME 兜底。 */
function fallbackImageMimeFromUrl(url: URL): string {
  const pathname = url.pathname.toLowerCase()
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg'
  if (pathname.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

/** 后端下载上游图片 URL，并转换成前端存储使用的 data URL。 */
async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal, redirects = 0): Promise<string> {
  if (isDataUrl(url)) return url
  if (redirects > MAX_IMAGE_REDIRECTS) throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 重定向次数过多')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 格式无效')
  }
  if (signal?.aborted) wrapUpstreamError(signal.reason, signal)
  let resolved: SafeResolvedAddress
  try {
    resolved = await resolveSafeImageUrl(parsed, signal)
  } catch (error) {
    if (signal?.aborted) wrapUpstreamError(error, signal)
    throw error
  }

  let response: Awaited<ReturnType<typeof requestImageBlob>>
  try {
    response = await requestImageBlob(parsed, resolved, signal)
  } catch (error) {
    if (isRecord(error) && typeof error.status === 'number' && typeof error.code === 'string') throw error
    if (signal?.aborted) wrapUpstreamError(error, signal)
    if (isAbortLikeError(error)) {
      const controller = new AbortController()
      controller.abort(error)
      wrapUpstreamError(error, controller.signal)
    }
    throw createHttpError(502, 'UPSTREAM_ERROR', normalizeErrorMessage(error))
  }
  if (response.statusCode >= 300 && response.statusCode < 400) {
    if (!response.redirectLocation) throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 重定向缺少 Location')
    return fetchImageUrlAsDataUrl(new URL(response.redirectLocation, parsed).toString(), fallbackMime, signal, redirects + 1)
  }
  const blob = response.blob
  if (!blob) throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 下载失败')
  if (blob.size > MAX_IMAGE_DOWNLOAD_BYTES) throw createHttpError(502, 'UPSTREAM_ERROR', '图片 URL 下载内容过大')
  return blobToDataUrl(blob, fallbackMime)
}

/** 按 OpenAI Images API 规则创建 JSON 请求体。 */
function createImagesJsonBody(input: ServerOpenAIRequest): Record<string, unknown> {
  const { profile, params } = input
  const prompt = profile.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${input.prompt}` : input.prompt
  const body: Record<string, unknown> = {
    model: profile.model,
    prompt,
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (!profile.codexCli) body.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) body.output_compression = params.output_compression
  if (params.n > 1) body.n = params.n
  if (profile.responseFormatB64Json) body.response_format = 'b64_json'

  return body
}

/** 按 OpenAI Images edits 规则创建 multipart 请求体。 */
function createImagesEditBody(input: ServerOpenAIRequest): FormData {
  const { profile, params } = input
  const prompt = profile.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${input.prompt}` : input.prompt
  const formData = new FormData()

  formData.append('model', profile.model)
  formData.append('prompt', prompt)
  formData.append('size', params.size)
  formData.append('output_format', params.output_format)
  formData.append('moderation', params.moderation)
  if (!profile.codexCli) formData.append('quality', params.quality)
  if (params.output_format !== 'png' && params.output_compression != null) formData.append('output_compression', String(params.output_compression))
  if (params.n > 1) formData.append('n', String(params.n))
  if (profile.responseFormatB64Json) formData.append('response_format', 'b64_json')

  assertInputImagesPayload(input)

  input.inputImageDataUrls.forEach((dataUrl, index) => {
    const shouldForcePng = Boolean(input.maskDataUrl) && index === 0
    const blob = dataUrlToBlob(dataUrl, 'image/png', shouldForcePng ? 'image/png' : undefined)
    const ext = shouldForcePng ? 'png' : blob.type.split('/')[1] || 'png'
    formData.append('image[]', blob, `input-${index + 1}.${ext}`)
  })
  if (input.maskDataUrl) {
    formData.append('mask', dataUrlToBlob(input.maskDataUrl, 'image/png', 'image/png'), 'mask.png')
  }

  return formData
}

/** 按 Responses API 规则创建输入内容，含图时使用 user/content 数组。 */
function createResponsesInput(prompt: string, inputImageDataUrls: string[]): unknown {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [{
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...inputImageDataUrls.map((imageUrl) => ({
        type: 'input_image',
        image_url: imageUrl,
      })),
    ],
  }]
}

/** 按 Responses API 规则创建 image_generation 工具配置。 */
function createResponsesTool(input: ServerOpenAIRequest): Record<string, unknown> {
  const { profile, params } = input
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: input.inputImageDataUrls.length > 0 ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
  }

  if (!profile.codexCli) tool.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) tool.output_compression = params.output_compression
  if (input.maskDataUrl) {
    tool.input_image_mask = { image_url: input.maskDataUrl }
  }

  return tool
}

/** 按 Responses API 规则创建 JSON 请求体。 */
function createResponsesBody(input: ServerOpenAIRequest): Record<string, unknown> {
  return {
    model: input.profile.model,
    input: createResponsesInput(input.prompt, input.inputImageDataUrls),
    tools: [createResponsesTool(input)],
    tool_choice: 'required',
  }
}

/** 将 fetch 异常转换为后端 API 约定的 HTTP 错误。 */
function wrapUpstreamError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) {
    const reason = signal.reason
    const isTimeout = reason instanceof DOMException && reason.name === 'TimeoutError'
    if (isTimeout) throw createHttpError(504, 'UPSTREAM_TIMEOUT', '请求超时，请稍后重试')
    throw createHttpError(499, 'REQUEST_ABORTED', '请求已取消')
  }
  throw createHttpError(502, 'UPSTREAM_ERROR', normalizeErrorMessage(error))
}

/** 判断错误是否为取消或超时类 DOM 异常。 */
function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** 向上游发送请求，集中处理超时和非 2xx 响应。 */
async function requestUpstream(url: string, init: RequestInit, requestSignal: TimeoutRequestSignal): Promise<Response> {
  if (requestSignal.signal.aborted) wrapUpstreamError(requestSignal.signal.reason, requestSignal.signal)
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', signal: requestSignal.signal })
    if (!response.ok) {
      throw createHttpError(502, 'UPSTREAM_ERROR', normalizeErrorMessage(await getUpstreamErrorMessage(response)))
    }
    return response
  } catch (error) {
    if (isRecord(error) && typeof error.status === 'number' && typeof error.code === 'string') throw error
    wrapUpstreamError(error, requestSignal.signal)
  }
}

/** 读取上游 JSON 响应，2xx 非 JSON 统一包装成 INVALID_UPSTREAM_RESPONSE。 */
async function readUpstreamJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (signal?.aborted || isAbortLikeError(error)) {
      const fallbackController = new AbortController()
      if (!signal?.aborted) fallbackController.abort(error)
      wrapUpstreamError(error, signal ?? fallbackController.signal)
    }
    throw createHttpError(502, 'INVALID_UPSTREAM_RESPONSE', '上游返回的 JSON 格式无效')
  }
}

/** 调用 Images API 或 Images edits API。 */
async function callImagesApi(
  input: ServerOpenAIRequest,
  endpoint: Exclude<OpenAICompatibleEndpoint, 'responses'>,
  outerSignal?: AbortSignal,
): Promise<ServerOpenAIResult> {
  if (input.profile.codexCli && endpoint === 'images/generations' && input.params.n > 1) {
    return callCodexCliImagesApiConcurrent(input, outerSignal)
  }

  const requestSignal = createTimeoutSignal(input.profile.timeout, outerSignal)
  const mime = MIME_MAP[input.params.output_format] || 'image/png'
  const url = buildUpstreamApiUrl(input.profile.baseUrl, endpoint)

  try {
    const isEdit = endpoint === 'images/edits'
    const response = await requestUpstream(url, {
      method: 'POST',
      headers: isEdit
        ? { Authorization: `Bearer ${input.profile.apiKey}` }
        : {
            Authorization: `Bearer ${input.profile.apiKey}`,
            'Content-Type': 'application/json',
          },
      body: isEdit ? createImagesEditBody(input) : JSON.stringify(createImagesJsonBody(input)),
    }, requestSignal)

    return parseImagesApiResponse(await readUpstreamJson(response, requestSignal.signal), mime, requestSignal.signal)
  } finally {
    requestSignal.cleanup()
  }
}

/** 复刻前端 codexCli 多图逻辑：拆成多次单图请求并合并成功结果。 */
async function callCodexCliImagesApiConcurrent(input: ServerOpenAIRequest, outerSignal?: AbortSignal): Promise<ServerOpenAIResult> {
  const n = Math.max(1, input.params.n)
  const singleInput: ServerOpenAIRequest = {
    ...input,
    params: { ...input.params, n: 1, quality: 'auto' },
  }
  const results = await Promise.allSettled(
    Array.from({ length: n }, () => callImagesApi(singleInput, 'images/generations', outerSignal)),
  )
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<ServerOpenAIResult> => result.status === 'fulfilled')
    .map((result) => result.value)

  if (!successfulResults.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (firstError) throw firstError.reason
    throw createHttpError(502, 'UPSTREAM_ERROR', '所有并发请求均失败')
  }

  const images = successfulResults.flatMap((result) => result.images)
  const actualParamsList = successfulResults.flatMap((result) =>
    result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((result) =>
    result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((result) => result.rawImageUrls ?? [])
  const actualParams = mergeActualParams(successfulResults[0]?.actualParams ?? {}, { n: images.length })

  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

/** 调用 Responses API。 */
async function callResponsesApi(input: ServerOpenAIRequest, outerSignal?: AbortSignal): Promise<ServerOpenAIResult> {
  if (input.params.n > 1) {
    return callResponsesApiConcurrent(input, outerSignal)
  }
  assertInputImagesPayload(input)

  const requestSignal = createTimeoutSignal(input.profile.timeout, outerSignal)
  const mime = MIME_MAP[input.params.output_format] || 'image/png'

  try {
    const response = await requestUpstream(buildUpstreamApiUrl(input.profile.baseUrl, 'responses'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createResponsesBody(input)),
    }, requestSignal)

    return parseResponsesApiResponse(await readUpstreamJson(response, requestSignal.signal), mime)
  } finally {
    requestSignal.cleanup()
  }
}

/** 复刻前端 Responses 多图逻辑：拆成多次单图请求并合并成功结果。 */
async function callResponsesApiConcurrent(input: ServerOpenAIRequest, outerSignal?: AbortSignal): Promise<ServerOpenAIResult> {
  const n = Math.max(1, input.params.n)
  const singleInput: ServerOpenAIRequest = {
    ...input,
    params: { ...input.params, n: 1 },
  }
  const results = await Promise.allSettled(
    Array.from({ length: n }, () => callResponsesApi(singleInput, outerSignal)),
  )
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<ServerOpenAIResult> => result.status === 'fulfilled')
    .map((result) => result.value)

  if (!successfulResults.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (firstError) throw firstError.reason
    throw createHttpError(502, 'UPSTREAM_ERROR', '所有并发请求均失败')
  }

  const images = successfulResults.flatMap((result) => result.images)
  const actualParamsList = successfulResults.flatMap((result) =>
    result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((result) =>
    result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((result) => result.rawImageUrls ?? [])
  const actualParams = mergeActualParams(successfulResults[0]?.actualParams ?? {}, { n: images.length })

  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

/** 解析 Images API 响应，支持 b64_json 和 URL 两种图片格式。 */
async function parseImagesApiResponse(payload: unknown, mime: string, signal?: AbortSignal): Promise<ServerOpenAIResult> {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : []
  const rawImageUrls = data
    .map((item) => isRecord(item) ? item.url : undefined)
    .filter(isHttpUrl)
  const images: string[] = []
  const revisedPrompts: Array<string | undefined> = []

  for (const item of data) {
    if (!isRecord(item)) continue
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      images.push(normalizeBase64Image(item.b64_json, mime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      continue
    }
    if (isHttpUrl(item.url) || isDataUrl(item.url)) {
      images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    }
  }

  if (!images.length) {
    throw createHttpError(502, 'INVALID_UPSTREAM_RESPONSE', '接口没有返回可识别的图片数据')
  }

  const actualParams = mergeActualParams(pickActualParams(payload))
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

/** 解析 Responses API 响应中的 image_generation_call 结果。 */
function parseResponsesApiResponse(payload: unknown, mime: string): ServerOpenAIResult {
  const output = isRecord(payload) && Array.isArray(payload.output) ? payload.output : []
  const results = output
    .filter(isRecord)
    .filter((item) => item.type === 'image_generation_call')
    .map((item) => ({
      image: typeof item.result === 'string' && item.result.trim()
        ? normalizeBase64Image(item.result, mime)
        : '',
      actualParams: mergeActualParams(pickActualParams(item)),
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    }))
    .filter((item) => item.image)

  if (!results.length) {
    throw createHttpError(502, 'INVALID_UPSTREAM_RESPONSE', '接口没有返回可识别的图片数据')
  }

  return {
    images: results.map((item) => item.image),
    actualParams: mergeActualParams(results[0]?.actualParams),
    actualParamsList: results.map((item) => item.actualParams),
    revisedPrompts: results.map((item) => item.revisedPrompt),
  }
}
