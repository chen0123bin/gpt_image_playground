# 前后端分离改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OpenAI 兼容接口请求从浏览器直连改为同源 Node.js 后端转发，移除旧 `/api-proxy/`，并保持 fal.ai 与自定义服务商仍走原有前端路径。

**Architecture:** 新增内置 Node.js 后端，开发环境由 Vite 将 `/api/openai-compatible/*` 代理到本机后端，生产环境由 Node 后端同时托管 `dist/` 静态文件与 API 路由。前端新增“服务端 API 模式”字段，OpenAI 兼容接口开启后调用同源后端；fal.ai 与自定义服务商不进入本版本后端化范围。

**Tech Stack:** React 19、Vite 6、TypeScript、Vitest、Node.js 20 原生 `http`/`fetch`/`FormData`、Docker `node:20-alpine`。

---

## 文件结构

- Create: `server/config.ts`  
  读取 `HOST`、`PORT`、`STATIC_DIR`、`DEFAULT_API_URL` 等后端运行配置。
- Create: `server/url.ts`  
  后端专用 URL 规范化与上游 API URL 拼接，避免复用浏览器 `import.meta.env` 代码。
- Create: `server/http.ts`  
  原生 Node HTTP 路由、JSON 解析、错误响应、静态文件服务和运行时占位符替换。
- Create: `server/openaiCompatible.ts`  
  OpenAI 兼容接口请求校验、Images API、Responses API、图片 URL 下载、超时与取消处理。
- Create: `server/index.ts`  
  后端入口，创建并启动 HTTP 服务。
- Create: `server/*.test.ts`  
  后端单元测试。
- Create: `tsconfig.server.json`  
  编译后端 TypeScript 到 `dist-server/`。
- Create: `src/lib/apiUrl.ts`  
  前端通用 API URL 规范化工具，替代 `src/lib/devProxy.ts` 中仍有价值的纯函数。
- Create: `src/lib/serverOpenAICompatibleApi.ts`  
  前端同源后端 API 客户端。
- Modify: `package.json`、`package-lock.json`  
  增加后端开发/构建/启动脚本与 `tsx`、`concurrently`、`@types/node` 开发依赖。
- Modify: `vite.config.ts`  
  删除旧 `dev-proxy.config.json` 读取逻辑；开发期只代理 `/api/openai-compatible` 到本机 Node 后端。
- Modify: `src/types.ts`、`src/lib/apiProfiles.ts`、`src/components/SettingsModal.tsx`、`src/store.ts`  
  将旧 `apiProxy` 行为迁移为 `serverApi`，UI 文案改为“服务端 API 模式”。
- Modify: `src/lib/api.ts`、`src/lib/openaiCompatibleImageApi.ts`  
  OpenAI 兼容接口在 `serverApi=true` 时调用后端；fal.ai 和自定义服务商保持现状。
- Delete: `src/lib/devProxy.ts`、`src/lib/devProxy.test.ts`、`dev-proxy.config.json`、`dev-proxy.config.example.json`。
- Modify/Delete: `deploy/Dockerfile`、`deploy/nginx.conf`、`deploy/inject-api-url.sh`、`deploy/migrate-api-env.envsh`  
  Docker 改为 Node 生产服务；删除 Nginx `/api-proxy/` 代理配置与代理环境变量注入。
- Modify: `README.md`、`src/vite-env.d.ts`、`src/hooks/useDockerApiUrlMigrationNotice.ts`、`src/App.tsx`  
  移除旧代理文档、旧代理环境变量、Docker API URL 拆分迁移提示。

## Task 1: 后端构建脚手架

**Files:**
- Create: `tsconfig.server.json`
- Create: `server/config.ts`
- Create: `server/config.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 写后端配置测试**

Create `server/config.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readServerConfig } from './config'

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
```

- [ ] **Step 2: 运行失败测试**

Run: `npx vitest run server/config.test.ts`

Expected: FAIL，提示无法解析 `./config`。

- [ ] **Step 3: 实现后端配置模块**

Create `server/config.ts`:

```ts
export interface ServerConfig {
  host: string
  port: number
  staticDir: string
  defaultApiUrl: string
}

/** 读取后端运行配置，保证 Docker 和本地开发使用同一套入口。 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsedPort = Number(env.PORT)
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8788,
    staticDir: env.STATIC_DIR?.trim() || 'dist',
    defaultApiUrl: env.DEFAULT_API_URL?.trim() || 'https://api.openai.com/v1',
  }
}
```

- [ ] **Step 4: 增加后端 TypeScript 配置**

Create `tsconfig.server.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "outDir": "dist-server",
    "types": ["node", "vitest/globals"]
  },
  "include": ["server/**/*.ts"]
}
```

- [ ] **Step 5: 更新 npm 脚本和依赖**

Modify `package.json` scripts:

```json
{
  "scripts": {
    "dev:web": "vite",
    "dev:server": "tsx server/index.ts",
    "dev": "concurrently -k -n web,server -c blue,green \"npm run dev:web\" \"npm run dev:server\"",
    "mock:api": "node scripts/mock-image-api.mjs",
    "build:server": "tsc -p tsconfig.server.json",
    "build": "tsc -b && vite build && npm run build:server",
    "deploy:cf": "npm run build && wrangler deploy",
    "preview": "npm run build && node dist-server/index.js",
    "start": "node dist-server/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Install dependencies:

```powershell
npm install -D @types/node tsx concurrently
```

- [ ] **Step 6: 验证后端配置测试通过**

Run: `npx vitest run server/config.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交脚手架**

```bash
git add package.json package-lock.json tsconfig.server.json server/config.ts server/config.test.ts
git commit -m "feat: add server build scaffold"
```

## Task 2: 后端 URL 与错误工具

**Files:**
- Create: `server/url.ts`
- Create: `server/url.test.ts`
- Create: `server/errors.ts`
- Create: `server/errors.test.ts`

- [ ] **Step 1: 写 URL 测试**

Create `server/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildUpstreamApiUrl, normalizeBaseUrl } from './url'

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
```

- [ ] **Step 2: 写错误清洗测试**

Create `server/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createHttpError, normalizeErrorMessage } from './errors'

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
})
```

- [ ] **Step 3: 运行失败测试**

Run: `npx vitest run server/url.test.ts server/errors.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 4: 实现 URL 工具**

Create `server/url.ts`:

```ts
/** 规范化 OpenAI 兼容接口 Base URL，避免后端误拼接重复路径。 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(input)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    const v1Index = pathSegments.indexOf('v1')
    const normalizedSegments = v1Index >= 0
      ? pathSegments.slice(0, v1Index + 1)
      : pathSegments
    const pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
    return `${url.origin}${pathname}`.replace(/\/+$/, '')
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

/** 拼接真实上游 API 地址，统一补齐 OpenAI 兼容接口的 v1 路径。 */
export function buildUpstreamApiUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const endpointPath = path.replace(/^\/+/, '')
  const apiPath = normalizedBaseUrl.endsWith('/v1')
    ? endpointPath
    : ['v1', endpointPath].join('/')
  return `${normalizedBaseUrl}/${apiPath}`
}
```

- [ ] **Step 5: 实现错误工具**

Create `server/errors.ts`:

```ts
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
```

- [ ] **Step 6: 验证通过**

Run: `npx vitest run server/url.test.ts server/errors.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交工具模块**

```bash
git add server/url.ts server/url.test.ts server/errors.ts server/errors.test.ts
git commit -m "feat: add server api utilities"
```

## Task 3: 后端 OpenAI 兼容接口服务

**Files:**
- Create: `server/openaiCompatible.ts`
- Create: `server/openaiCompatible.test.ts`

- [ ] **Step 1: 写请求校验与 Images API 测试**

Create `server/openaiCompatible.test.ts` with the first test block:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callOpenAICompatibleFromServer } from './openaiCompatible'

const baseRequest = {
  profile: {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-image-2',
    apiMode: 'images',
    timeout: 600,
    codexCli: false,
    responseFormatB64Json: false,
  },
  prompt: '画一只玻璃杯',
  params: {
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    output_compression: null,
    moderation: 'auto',
    n: 1,
  },
  inputImageDataUrls: [],
}

describe('callOpenAICompatibleFromServer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('拒绝缺少 API Key 的请求', async () => {
    await expect(callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiKey: '' },
    })).rejects.toMatchObject({
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
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(result.revisedPrompts).toEqual(['玻璃杯'])
    expect(result.actualParams).toEqual({
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
    })
  })
})
```

- [ ] **Step 2: 追加 Responses API 与图片 URL 下载测试**

Append to `server/openaiCompatible.test.ts` inside the same `describe`:

```ts
  it('调用 Responses API 并解析 image_generation_call 结果', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', result: 'cmVzcG9uc2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callOpenAICompatibleFromServer({
      ...baseRequest,
      profile: { ...baseRequest.profile, apiMode: 'responses' },
    })

    expect(result.images).toEqual(['data:image/png;base64,cmVzcG9uc2U='])
  })

  it('由后端下载上游返回的图片 URL 并转为 data URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ url: 'https://cdn.example.com/image.png' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }))

    const result = await callOpenAICompatibleFromServer(baseRequest)

    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.com/image.png')
    expect(result.images).toEqual(['data:image/png;base64,AQID'])
    expect(result.rawImageUrls).toEqual(['https://cdn.example.com/image.png'])
  })
```

- [ ] **Step 3: 追加超时测试**

Append to `server/openaiCompatible.test.ts`:

```ts
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

    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).rejects.toThrow('请求超时')
  })
```

- [ ] **Step 4: 运行失败测试**

Run: `npx vitest run server/openaiCompatible.test.ts`

Expected: FAIL，提示无法解析 `./openaiCompatible`。

- [ ] **Step 5: 实现后端 OpenAI 兼容服务**

Create `server/openaiCompatible.ts` with these exported functions and interfaces. Implementation must include function-level Chinese comments:

```ts
import { createHttpError, normalizeErrorMessage } from './errors'
import { buildUpstreamApiUrl } from './url'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

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

/** 校验服务端 OpenAI 兼容接口请求的必填字段。 */
export function validateServerOpenAIRequest(input: ServerOpenAIRequest): void {
  if (!input.profile?.baseUrl?.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少 API URL')
  if (!input.profile?.apiKey?.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少 API Key')
  if (!input.profile?.model?.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少模型 ID')
  if (!input.prompt?.trim()) throw createHttpError(400, 'VALIDATION_ERROR', '缺少提示词')
}

/** 调用 OpenAI 兼容接口并返回前端已有结构需要的图片结果。 */
export async function callOpenAICompatibleFromServer(
  input: ServerOpenAIRequest,
  endpoint?: 'images/generations' | 'images/edits' | 'responses',
  outerSignal?: AbortSignal,
): Promise<ServerOpenAIResult> {
  validateServerOpenAIRequest(input)
  const resolvedEndpoint = endpoint ?? (input.profile.apiMode === 'responses' ? 'responses' : 'images/generations')
  return resolvedEndpoint === 'responses'
    ? callResponses(input, outerSignal)
    : callImages(input, resolvedEndpoint, outerSignal)
}
```

Continue the file with concrete helpers:

```ts
/** 根据用户配置创建可中断的超时控制器。 */
function createTimeoutSignal(timeoutSeconds: number, outerSignal?: AbortSignal) {
  const controller = new AbortController()
  const timeoutMs = Math.min(Math.max(timeoutSeconds || 600, 1), 900) * 1000
  const timeoutId = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs)
  outerSignal?.addEventListener('abort', () => controller.abort(new DOMException('请求已取消', 'AbortError')), { once: true })
  return { signal: controller.signal, cleanup: () => clearTimeout(timeoutId) }
}

/** 将 data URL 转为 Node 可提交给上游的 Blob。 */
function dataUrlToBlob(dataUrl: string, fallbackType = 'image/png'): Blob {
  const [meta, payload = ''] = dataUrl.split(',', 2)
  const mime = /^data:([^;,]+)/.exec(meta)?.[1] ?? fallbackType
  const bytes = /;base64/i.test(meta)
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload))
  return new Blob([bytes], { type: mime })
}

/** 将图片 Blob 转成 data URL。 */
async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = Buffer.from(await blob.arrayBuffer())
  return `data:${blob.type || fallbackMime};base64,${bytes.toString('base64')}`
}

/** 将上游返回的 base64 字符串规范化为 data URL。 */
function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

/** 下载上游图片 URL，避免浏览器再次遇到图片链接 CORS。 */
async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok) throw createHttpError(502, 'IMAGE_FETCH_ERROR', `图片 URL 下载失败：HTTP ${response.status}`)
  return blobToDataUrl(await response.blob(), fallbackMime)
}
```

Finish implementation by porting the existing Images and Responses request body logic from `src/lib/openaiCompatibleImageApi.ts` into server functions:

```ts
/** 调用 Images API 的生成或编辑端点。 */
async function callImages(
  input: ServerOpenAIRequest,
  endpoint: 'images/generations' | 'images/edits',
  outerSignal?: AbortSignal,
): Promise<ServerOpenAIResult> {
  const { signal, cleanup } = createTimeoutSignal(input.profile.timeout, outerSignal)
  const mime = MIME_MAP[input.params.output_format] || 'image/png'
  const url = buildUpstreamApiUrl(input.profile.baseUrl, endpoint)

  try {
    const init = endpoint === 'images/edits'
      ? createEditRequestInit(input, signal)
      : createGenerationRequestInit(input, signal)
    const response = await fetch(url, init)
    if (!response.ok) throw createHttpError(response.status, 'UPSTREAM_ERROR', await readApiErrorMessage(response))
    const payload = await response.json() as any
    return extractImagesApiResult(payload, mime, signal)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw createHttpError(408, 'UPSTREAM_TIMEOUT', '请求超时，请稍后重试或降低图片尺寸/质量')
    }
    throw error
  } finally {
    cleanup()
  }
}

/** 调用 Responses API 并解析 image_generation_call。 */
async function callResponses(input: ServerOpenAIRequest, outerSignal?: AbortSignal): Promise<ServerOpenAIResult> {
  const { signal, cleanup } = createTimeoutSignal(input.profile.timeout, outerSignal)
  const mime = MIME_MAP[input.params.output_format] || 'image/png'
  try {
    const response = await fetch(buildUpstreamApiUrl(input.profile.baseUrl, 'responses'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        model: input.profile.model,
        input: `Use the following text as the complete prompt. Do not rewrite it:\n${input.prompt}`,
        tools: [{
          type: 'image_generation',
          action: input.inputImageDataUrls.length > 0 ? 'edit' : 'generate',
          size: input.params.size,
          output_format: input.params.output_format,
          quality: input.profile.codexCli ? undefined : input.params.quality,
        }],
        tool_choice: 'required',
      }),
      signal,
    })
    if (!response.ok) throw createHttpError(response.status, 'UPSTREAM_ERROR', await readApiErrorMessage(response))
    const payload = await response.json() as any
    const images = (payload.output ?? [])
      .filter((item: any) => item?.type === 'image_generation_call' && typeof item.result === 'string')
      .map((item: any) => normalizeBase64Image(item.result, mime))
    if (!images.length) throw createHttpError(502, 'INVALID_UPSTREAM_RESPONSE', '接口没有返回可识别的图片数据')
    return { images }
  } finally {
    cleanup()
  }
}
```

The remaining helpers in this file must be concrete ports of existing client logic:

```ts
/** 创建 Images API 文生图请求。 */
function createGenerationRequestInit(input: ServerOpenAIRequest, signal: AbortSignal): RequestInit {
  const body: Record<string, unknown> = {
    model: input.profile.model,
    prompt: input.profile.codexCli
      ? `Use the following text as the complete prompt. Do not rewrite it:\n${input.prompt}`
      : input.prompt,
    size: input.params.size,
    output_format: input.params.output_format,
    moderation: input.params.moderation,
  }
  if (!input.profile.codexCli) body.quality = input.params.quality
  if (input.params.output_format !== 'png' && input.params.output_compression != null) {
    body.output_compression = input.params.output_compression
  }
  if (input.params.n > 1) body.n = input.params.n
  if (input.profile.responseFormatB64Json) body.response_format = 'b64_json'

  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
    signal,
  }
}

/** 创建 Images API 图片编辑请求。 */
function createEditRequestInit(input: ServerOpenAIRequest, signal: AbortSignal): RequestInit {
  const formData = new FormData()
  formData.append('model', input.profile.model)
  formData.append('prompt', input.prompt)
  formData.append('size', input.params.size)
  formData.append('output_format', input.params.output_format)
  formData.append('moderation', input.params.moderation)
  if (!input.profile.codexCli) formData.append('quality', input.params.quality)
  if (input.params.n > 1) formData.append('n', String(input.params.n))
  if (input.profile.responseFormatB64Json) formData.append('response_format', 'b64_json')
  input.inputImageDataUrls.forEach((dataUrl, index) => {
    const blob = dataUrlToBlob(dataUrl)
    formData.append('image[]', blob, `input-${index + 1}.png`)
  })
  if (input.maskDataUrl) formData.append('mask', dataUrlToBlob(input.maskDataUrl, 'image/png'), 'mask.png')

  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.profile.apiKey}` },
    cache: 'no-store',
    body: formData,
    signal,
  }
}
```

- [ ] **Step 6: 验证服务测试通过**

Run: `npx vitest run server/openaiCompatible.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交后端服务**

```bash
git add server/openaiCompatible.ts server/openaiCompatible.test.ts
git commit -m "feat: add server openai compatible client"
```

## Task 4: HTTP 路由与静态文件服务

**Files:**
- Create: `server/http.ts`
- Create: `server/http.test.ts`
- Create: `server/index.ts`

- [ ] **Step 1: 写 API 路由测试**

Create `server/http.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './http'

const requestBody = {
  profile: {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-image-2',
    apiMode: 'images',
    timeout: 600,
  },
  prompt: 'prompt',
  params: {
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    output_compression: null,
    moderation: 'auto',
    n: 1,
  },
  inputImageDataUrls: [],
}

describe('server http app', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('处理 OpenAI 兼容接口生成请求', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const app = createApp({ staticDir: 'dist', defaultApiUrl: 'https://api.openai.com/v1' })

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
  })

  it('拒绝未知 API 路径', async () => {
    const app = createApp({ staticDir: 'dist', defaultApiUrl: 'https://api.openai.com/v1' })

    const response = await app.fetch(new Request('http://localhost/api/unknown', { method: 'POST' }))

    expect(response.status).toBe(404)
  })

  it('错误响应不会泄露 Authorization 内容', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Authorization: Bearer sk-secret\n上游失败'))
    const app = createApp({ staticDir: 'dist', defaultApiUrl: 'https://api.openai.com/v1' })

    const response = await app.fetch(new Request('http://localhost/api/openai-compatible/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }))
    const payload = await response.json()

    expect(response.status).toBe(500)
    expect(payload.error.message).not.toContain('sk-secret')
  })
})
```

- [ ] **Step 2: 运行失败测试**

Run: `npx vitest run server/http.test.ts`

Expected: FAIL，提示无法解析 `./http`。

- [ ] **Step 3: 实现 HTTP app**

Create `server/http.ts`:

```ts
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { callOpenAICompatibleFromServer, type ServerOpenAIRequest } from './openaiCompatible'
import { toHttpError } from './errors'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export interface AppConfig {
  staticDir: string
  defaultApiUrl: string
}

/** 创建可测试的 HTTP app，生产入口会把它接到 Node server 上。 */
export function createApp(config: AppConfig) {
  return {
    fetch: (request: Request) => handleRequest(request, config),
  }
}

/** 处理 API 路由和静态资源路由。 */
export async function handleRequest(request: Request, config: AppConfig): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/openai-compatible/')) {
    return handleOpenAICompatibleRoute(request, url.pathname)
  }
  if (url.pathname.startsWith('/api/')) {
    return jsonResponse({ error: { message: '接口不存在', code: 'NOT_FOUND', status: 404 } }, 404)
  }
  return serveStatic(url.pathname, config)
}

/** 处理 OpenAI 兼容接口服务端 API 路由。 */
async function handleOpenAICompatibleRoute(request: Request, pathname: string): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: { message: '仅支持 POST 请求', code: 'METHOD_NOT_ALLOWED', status: 405 } }, 405)
  }
  const endpoint = pathname.replace('/api/openai-compatible/', '') as 'images/generations' | 'images/edits' | 'responses'
  if (!['images/generations', 'images/edits', 'responses'].includes(endpoint)) {
    return jsonResponse({ error: { message: '接口不存在', code: 'NOT_FOUND', status: 404 } }, 404)
  }
  try {
    const payload = await request.json() as ServerOpenAIRequest
    const result = await callOpenAICompatibleFromServer(payload, endpoint, request.signal)
    return jsonResponse(result)
  } catch (error) {
    const httpError = toHttpError(error)
    return jsonResponse({
      error: {
        message: httpError.message,
        code: httpError.code,
        status: httpError.status,
      },
    }, httpError.status)
  }
}

/** 返回 JSON 响应。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
```

Add static serving in the same file:

```ts
/** 返回静态文件，找不到具体文件时回退到 SPA 的 index.html。 */
function serveStatic(pathname: string, config: AppConfig): Response {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const relativePath = safePath === '/' || safePath === '.' ? 'index.html' : safePath.replace(/^[/\\]+/, '')
  const filePath = join(config.staticDir, relativePath)
  const finalPath = existsSync(filePath) && statSync(filePath).isFile()
    ? filePath
    : join(config.staticDir, 'index.html')
  if (!existsSync(finalPath)) {
    return new Response('Not found', { status: 404 })
  }
  const ext = extname(finalPath)
  return new Response(Readable.toWeb(createReadStream(finalPath)) as BodyInit, {
    headers: { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' },
  })
}
```

- [ ] **Step 4: 实现服务入口**

Create `server/index.ts`:

```ts
import { createServer } from 'node:http'
import { readServerConfig } from './config'
import { createApp } from './http'

const config = readServerConfig()
const app = createApp(config)

/** 启动 Node HTTP 服务，同时承载 API 和前端静态文件。 */
function startServer() {
  const server = createServer(async (req, res) => {
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const response = await app.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    }
    res.end()
  })

  server.listen(config.port, config.host, () => {
    console.log(`gpt-image-playground server listening on http://${config.host}:${config.port}`)
  })
}

startServer()
```

- [ ] **Step 5: 验证 HTTP 测试通过**

Run: `npx vitest run server/http.test.ts`

Expected: PASS。

- [ ] **Step 6: 验证后端编译通过**

Run: `npm run build:server`

Expected: PASS，并生成 `dist-server/index.js`。

- [ ] **Step 7: 提交 HTTP 服务**

```bash
git add server/http.ts server/http.test.ts server/index.ts
git commit -m "feat: add node api server"
```

## Task 5: 前端 API URL 与配置字段迁移

**Files:**
- Create: `src/lib/apiUrl.ts`
- Create: `src/lib/apiUrl.test.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/apiProfiles.ts`
- Modify: `src/lib/apiProfiles.test.ts`
- Modify: `src/lib/urlSettings.ts`
- Modify: `src/lib/urlSettings.test.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: 写前端 URL 工具测试**

Create `src/lib/apiUrl.test.ts`:

```ts
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
```

- [ ] **Step 2: 实现前端 URL 工具**

Create `src/lib/apiUrl.ts`:

```ts
/** 规范化用户填写的 API Base URL。 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(input)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    const v1Index = pathSegments.indexOf('v1')
    const normalizedSegments = v1Index >= 0
      ? pathSegments.slice(0, v1Index + 1)
      : pathSegments.length
        ? [...pathSegments, 'v1']
        : []
    const pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
    return `${url.origin}${pathname}`
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

/** 拼接浏览器直连上游 API 的 URL。 */
export function buildDirectApiUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const endpointPath = path.replace(/^\/+/, '')
  const apiPath = normalizedBaseUrl.endsWith('/v1') ? endpointPath : ['v1', endpointPath].join('/')
  return normalizedBaseUrl ? `${normalizedBaseUrl}/${apiPath}` : `/${apiPath}`
}

/** 拼接同源 Node 后端 OpenAI 兼容接口 URL。 */
export function buildServerOpenAIUrl(path: string): string {
  return `/api/openai-compatible/${path.replace(/^\/+/, '')}`
}
```

- [ ] **Step 3: 运行 URL 测试**

Run: `npx vitest run src/lib/apiUrl.test.ts`

Expected: PASS。

- [ ] **Step 4: 修改类型字段**

Modify `src/types.ts`:

```ts
export interface ApiProfile {
  id: string
  name: string
  provider: ApiProvider
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  serverApi: boolean
  responseFormatB64Json?: boolean
  providerDrafts?: Partial<Record<ApiProvider, Partial<Pick<ApiProfile, 'baseUrl' | 'model' | 'apiMode' | 'codexCli' | 'serverApi' | 'responseFormatB64Json'>>>>
}

export interface AppSettings {
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  serverApi: boolean
  customProviders: CustomProviderDefinition[]
  providerOrder?: string[]
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  enterSubmit: boolean
  profiles: ApiProfile[]
  activeProfileId: string
}
```

- [ ] **Step 5: 修改配置归一化**

Modify `src/lib/apiProfiles.ts`:

```ts
const DEFAULT_OPENAI_SERVER_API = true
```

Replace all `apiProxy` profile fields with `serverApi`. When reading persisted data, migrate legacy `apiProxy`:

```ts
function readServerApiFlag(record: Record<string, unknown>, defaults: Pick<ApiProfile, 'serverApi'>): boolean {
  if (typeof record.serverApi === 'boolean') return record.serverApi
  if (typeof record.apiProxy === 'boolean') return record.apiProxy
  return defaults.serverApi
}
```

Use `readServerApiFlag(record, defaults)` in `normalizeApiProfile`, and set `serverApi: DEFAULT_OPENAI_SERVER_API` for OpenAI profiles, `serverApi: false` for fal.ai and custom providers.

- [ ] **Step 6: 更新配置测试**

Modify `src/lib/apiProfiles.test.ts` assertions:

```ts
expect(profile.serverApi).toBe(true)
expect(falProfile.serverApi).toBe(false)
```

Add migration test:

```ts
it('migrates legacy apiProxy to serverApi', () => {
  const settings = normalizeSettings({
    profiles: [{
      id: 'legacy',
      name: 'Legacy',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'key',
      model: 'model',
      timeout: 600,
      apiMode: 'images',
      codexCli: false,
      apiProxy: false,
    }],
    activeProfileId: 'legacy',
  })

  expect(settings.profiles[0].serverApi).toBe(false)
})
```

- [ ] **Step 7: 更新 API 导出**

Modify `src/lib/api.ts`:

```ts
export { normalizeBaseUrl } from './apiUrl'
```

Modify `src/lib/urlSettings.ts` import:

```ts
import { normalizeBaseUrl } from './apiUrl'
```

- [ ] **Step 8: 跑相关测试**

Run:

```powershell
npx vitest run src/lib/apiUrl.test.ts src/lib/apiProfiles.test.ts src/lib/urlSettings.test.ts
```

Expected: PASS。

- [ ] **Step 9: 提交配置迁移**

```bash
git add src/types.ts src/lib/apiUrl.ts src/lib/apiUrl.test.ts src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts src/lib/urlSettings.ts src/lib/urlSettings.test.ts src/lib/api.ts
git commit -m "feat: add server api profile setting"
```

## Task 6: 前端服务端 API 客户端

**Files:**
- Create: `src/lib/serverOpenAICompatibleApi.ts`
- Create: `src/lib/serverOpenAICompatibleApi.test.ts`
- Modify: `src/lib/openaiCompatibleImageApi.ts`
- Modify: `src/lib/api.test.ts`

- [ ] **Step 1: 写服务端 API 客户端测试**

Create `src/lib/serverOpenAICompatibleApi.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { callServerOpenAICompatibleImageApi } from './serverOpenAICompatibleApi'

describe('callServerOpenAICompatibleImageApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('向同源后端发送 Images API 请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,aW1hZ2U='],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

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

  it('编辑图片时调用 images/edits', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,aW1hZ2U='],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callServerOpenAICompatibleImageApi({
      settings: {} as any,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    }, createDefaultOpenAIProfile({ apiKey: 'key', apiMode: 'images' }))

    expect(fetchMock.mock.calls[0][0]).toBe('/api/openai-compatible/images/edits')
  })

  it('Responses API 调用 responses 路径', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,aW1hZ2U='],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callServerOpenAICompatibleImageApi({
      settings: {} as any,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultOpenAIProfile({ apiKey: 'key', apiMode: 'responses' }))

    expect(fetchMock.mock.calls[0][0]).toBe('/api/openai-compatible/responses')
  })
})
```

- [ ] **Step 2: 实现服务端 API 客户端**

Create `src/lib/serverOpenAICompatibleApi.ts`:

```ts
import type { ApiProfile } from '../types'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { getApiErrorMessage } from './imageApiShared'
import { buildServerOpenAIUrl } from './apiUrl'

/** 通过同源 Node 后端调用 OpenAI 兼容接口。 */
export async function callServerOpenAICompatibleImageApi(
  opts: CallApiOptions,
  profile: ApiProfile,
): Promise<CallApiResult> {
  const endpoint = profile.apiMode === 'responses'
    ? 'responses'
    : opts.inputImageDataUrls.length > 0
      ? 'images/edits'
      : 'images/generations'
  const response = await fetch(buildServerOpenAIUrl(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      profile,
      prompt: opts.prompt,
      params: opts.params,
      inputImageDataUrls: opts.inputImageDataUrls,
      maskDataUrl: opts.maskDataUrl ?? null,
    }),
  })

  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  return response.json() as Promise<CallApiResult>
}
```

- [ ] **Step 3: 修改 OpenAI 兼容入口**

Modify `src/lib/openaiCompatibleImageApi.ts`:

```ts
import { buildDirectApiUrl } from './apiUrl'
import { callServerOpenAICompatibleImageApi } from './serverOpenAICompatibleApi'
```

At the start of `callOpenAICompatibleImageApi`:

```ts
  if (!customProvider && profile.provider === 'openai' && profile.serverApi) {
    return callServerOpenAICompatibleImageApi(opts, profile)
  }
```

Replace old `buildApiUrl(...)` calls for direct OpenAI and custom providers with `buildDirectApiUrl(profile.baseUrl, path)`.

- [ ] **Step 4: 更新 API 测试**

Modify `src/lib/api.test.ts`:

Remove tests named:

- `uses the same-origin API proxy path when API proxy is enabled`
- `uses the same-origin API proxy path when API proxy is locked`
- `ignores stored API proxy settings when the current deployment has no proxy`

Add:

```ts
  it('uses same-origin server API path for OpenAI compatible requests when enabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      images: ['data:image/png;base64,aW1hZ2U='],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        serverApi: true,
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          apiKey: 'test-key',
          serverApi: true,
        }],
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/openai-compatible/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps custom providers on the direct/custom HTTP path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          template: 'http-image',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            body: { model: '$profile.model', prompt: '$prompt' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'custom-profile',
          provider: 'custom-sync',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
          serverApi: false,
        }],
        activeProfileId: 'custom-profile',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations')
  })
```

- [ ] **Step 5: 跑前端 API 测试**

Run:

```powershell
npx vitest run src/lib/serverOpenAICompatibleApi.test.ts src/lib/api.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交前端 API 客户端**

```bash
git add src/lib/serverOpenAICompatibleApi.ts src/lib/serverOpenAICompatibleApi.test.ts src/lib/openaiCompatibleImageApi.ts src/lib/api.test.ts
git commit -m "feat: route openai requests through server api"
```

## Task 7: 设置 UI 与错误提示改为服务端 API 模式

**Files:**
- Modify: `src/components/SettingsModal.tsx`
- Modify: `src/store.ts`
- Modify: `src/store.test.ts`

- [ ] **Step 1: 写设置迁移/任务测试**

Modify `src/store.test.ts` by replacing `apiProxy` expectations with `serverApi` and adding:

```ts
it('keeps serverApi on reused OpenAI task profiles', () => {
  const openaiProfile = createDefaultOpenAIProfile({
    id: 'openai-profile',
    apiKey: 'openai-key',
    serverApi: true,
  })
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [openaiProfile],
    activeProfileId: openaiProfile.id,
  })

  expect(settings.profiles[0].serverApi).toBe(true)
})
```

- [ ] **Step 2: 修改 SettingsModal 导入**

Modify top imports:

```ts
import { normalizeBaseUrl } from '../lib/api'
```

Remove:

```ts
import { isApiProxyAvailable, isApiProxyLocked, readClientDevProxyConfig } from '../lib/devProxy'
```

- [ ] **Step 3: 替换 UI 状态变量**

In `SettingsModal.tsx`, replace proxy state with:

```ts
  const activeProfile = draft.profiles.find((profile) => profile.id === draft.activeProfileId) ?? draft.profiles[0] ?? getActiveApiProfile(draft)
  const serverApiEnabled = activeProfile.provider === 'openai' && activeProfile.serverApi
```

Remove `apiProxyConfig`、`apiProxyAvailable`、`apiProxyLocked`、`apiProxyChecked`、`apiProxyEnabled`。

- [ ] **Step 4: 提交配置时保留 serverApi**

In `commitSettings`, set:

```ts
serverApi: profile.provider === 'openai' ? profile.serverApi : false,
```

Remove all writes to `apiProxy`.

- [ ] **Step 5: 更新 API URL 输入框说明**

Keep API URL input enabled. Replace the hint with:

```tsx
<span>服务端 API 模式会由本项目后端请求该地址。支持通过查询参数覆盖：<code className="bg-gray-100 dark:bg-white/[0.06] px-1 py-0.5 rounded">?apiUrl=</code></span>
```

- [ ] **Step 6: 替换开关 UI**

Replace the old API proxy block with:

```tsx
{activeProfile.provider === 'openai' && (
  <div className="block">
    <div className="mb-1.5 flex items-center justify-between">
      <span className="block text-sm text-gray-600 dark:text-gray-300">服务端 API 模式</span>
      <button
        type="button"
        onClick={() => updateActiveProfile({ serverApi: !activeProfile.serverApi }, true)}
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${serverApiEnabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
        role="switch"
        aria-checked={serverApiEnabled}
        aria-label="服务端 API 模式"
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${serverApiEnabled ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
      </button>
    </div>
    <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
      开启后浏览器只请求同源后端，由后端访问 OpenAI 兼容接口并下载结果图片。
    </div>
  </div>
)}
```

- [ ] **Step 7: 更新网络错误提示**

Modify `src/store.ts` `getApiRequestNetworkErrorHint`:

```ts
  const usesServerApi = profile?.serverApi ?? settings.serverApi

  if (elapsedSeconds <= 15) {
    if (usesServerApi) {
      return '提示：请求立即失败，请检查本项目后端服务是否正常运行。'
    }
    return '提示：接口可能不支持浏览器跨域请求，可开启服务端 API 模式解决。'
  }
```

- [ ] **Step 8: 运行设置相关测试**

Run:

```powershell
npx vitest run src/store.test.ts src/lib/apiProfiles.test.ts
```

Expected: PASS。

- [ ] **Step 9: 提交 UI 和提示**

```bash
git add src/components/SettingsModal.tsx src/store.ts src/store.test.ts
git commit -m "feat: expose server api mode"
```

## Task 8: 移除旧 `/api-proxy/` 开发代理

**Files:**
- Modify: `vite.config.ts`
- Modify: `src/vite-env.d.ts`
- Delete: `src/lib/devProxy.ts`
- Delete: `src/lib/devProxy.test.ts`
- Delete: `dev-proxy.config.json`
- Delete: `dev-proxy.config.example.json`

- [ ] **Step 1: 改写 Vite 配置**

Modify `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig(() => ({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true,
    proxy: {
      '/api/openai-compatible': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
}))
```

- [ ] **Step 2: 删除旧代理类型**

Modify `src/vite-env.d.ts` to remove:

```ts
readonly VITE_API_PROXY_AVAILABLE?: string
readonly VITE_API_PROXY_LOCKED?: string
```

- [ ] **Step 3: 删除旧代理文件**

Run:

```powershell
Remove-Item -LiteralPath 'src/lib/devProxy.ts'
Remove-Item -LiteralPath 'src/lib/devProxy.test.ts'
Remove-Item -LiteralPath 'dev-proxy.config.json'
Remove-Item -LiteralPath 'dev-proxy.config.example.json'
```

- [ ] **Step 4: 确认没有旧代理引用**

Run:

```powershell
rg -n "devProxy|/api-proxy|VITE_API_PROXY|API_PROXY|apiProxy|API 代理" src vite.config.ts package.json README.md deploy docs
```

Expected: only `docs/superpowers` historical spec/log lines may remain. No `src`、`vite.config.ts`、`deploy`、`README.md` matches.

- [ ] **Step 5: 运行前端测试**

Run:

```powershell
npm run test
```

Expected: PASS.

- [ ] **Step 6: 提交旧代理移除**

```bash
git add vite.config.ts src/vite-env.d.ts src/lib/apiUrl.ts src/lib/apiUrl.test.ts
git rm src/lib/devProxy.ts src/lib/devProxy.test.ts dev-proxy.config.json dev-proxy.config.example.json
git commit -m "refactor: remove legacy api proxy"
```

## Task 9: Docker 与生产 Node 服务

**Files:**
- Modify: `deploy/Dockerfile`
- Delete: `deploy/nginx.conf`
- Delete: `deploy/inject-api-url.sh`
- Delete: `deploy/migrate-api-env.envsh`
- Modify: `src/hooks/useDockerApiUrlMigrationNotice.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: 改写 Dockerfile**

Modify `deploy/Dockerfile`:

```dockerfile
# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__
ENV VITE_DOCKER_DEPLOYMENT=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=80
ENV STATIC_DIR=/app/dist
ENV DEFAULT_API_URL=https://api.openai.com/v1

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

EXPOSE 80

CMD ["node", "dist-server/index.js"]
```

- [ ] **Step 2: 删除 Nginx 与注入脚本**

Run:

```powershell
Remove-Item -LiteralPath 'deploy/nginx.conf'
Remove-Item -LiteralPath 'deploy/inject-api-url.sh'
Remove-Item -LiteralPath 'deploy/migrate-api-env.envsh'
```

- [ ] **Step 3: 移除 Docker API URL 拆分提示**

Delete `src/hooks/useDockerApiUrlMigrationNotice.ts`.

Modify `src/App.tsx` remove:

```ts
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
```

and remove:

```ts
useDockerApiUrlMigrationNotice()
```

- [ ] **Step 4: 实现运行时 DEFAULT_API_URL 替换**

Modify `server/http.ts` static JS serving. Add:

```ts
/** 替换前端构建产物中的运行时环境占位符。 */
function replaceRuntimePlaceholders(content: string, config: AppConfig): string {
  return content
    .replaceAll('__VITE_DEFAULT_API_URL_PLACEHOLDER__', config.defaultApiUrl)
    .replaceAll('__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__', 'true')
}
```

For `.js` files, read as text and return replaced content instead of streaming. Use Node `readFileSync`:

```ts
if (ext === '.js') {
  const content = replaceRuntimePlaceholders(readFileSync(finalPath, 'utf-8'), config)
  return new Response(content, {
    headers: { 'Content-Type': MIME_TYPES[ext] ?? 'application/javascript; charset=utf-8' },
  })
}
```

- [ ] **Step 5: 运行构建**

Run:

```powershell
npm run build
```

Expected: PASS，生成 `dist/` 和 `dist-server/`。

- [ ] **Step 6: 提交 Docker 改造**

```bash
git add deploy/Dockerfile server/http.ts src/App.tsx
git rm deploy/nginx.conf deploy/inject-api-url.sh deploy/migrate-api-env.envsh src/hooks/useDockerApiUrlMigrationNotice.ts
git commit -m "feat: serve production with node backend"
```

## Task 10: 文档与最终验证

**Files:**
- Modify: `README.md`
- Modify: `docs/mock-image-api.md`
- Modify: `docs/superpowers/v0.0.1/execution-log.md`

- [ ] **Step 1: 更新 README 功能描述**

Modify README feature section:

```md
- **服务端 API 模式**：OpenAI 兼容接口可通过同源 Node.js 后端请求真实 API，避免浏览器 CORS 限制，并由后端下载结果图片 URL。fal.ai 和自定义服务商在当前版本仍沿用原有前端请求路径。
```

Remove all README references to:

```text
/api-proxy
API_PROXY_URL
ENABLE_API_PROXY
LOCK_API_PROXY
dev-proxy.config.json
```

- [ ] **Step 2: 更新本地开发说明**

Replace local development section with:

```md
```bash
npm install
npm run dev
```

`npm run dev` 会同时启动 Vite 前端和 Node 后端。开发环境中浏览器请求 `/api/openai-compatible/*`，由 Vite 转发到本机 Node 后端，再由 Node 后端请求真实 OpenAI 兼容接口。
```
```

- [ ] **Step 3: 更新 Docker 说明**

Replace Docker env section:

```md
- `DEFAULT_API_URL`：设置页面上默认显示的 OpenAI 兼容接口地址。
- `HOST` / `PORT`：指定容器内 Node 服务监听地址和端口，默认 `0.0.0.0:80`。
```

Use Docker example:

```bash
docker run -d -p 8080:80 \
  -e DEFAULT_API_URL=https://api.openai.com/v1 \
  ghcr.io/cooksleep/gpt_image_playground:latest
```

- [ ] **Step 4: 更新 mock 文档**

Modify `docs/mock-image-api.md` to explain:

```md
使用服务端 API 模式后，API 请求阶段的 CORS 会由本项目后端绕过；图片 URL 下载也会由后端完成。`api-no-cors` 和 `url-cors-block` 可用于验证旧前端直连问题已不再出现。
```

- [ ] **Step 5: 运行全文旧代理扫描**

Run:

```powershell
rg -n "/api-proxy|API_PROXY|ENABLE_API_PROXY|LOCK_API_PROXY|dev-proxy|API 代理|apiProxy|VITE_API_PROXY" . --glob "!node_modules/**" --glob "!docs/superpowers/**"
```

Expected: no matches.

- [ ] **Step 6: 运行完整验证**

Run:

```powershell
npm run test
npm run build
```

Expected: both PASS。

- [ ] **Step 7: 记录验证结果**

Append to `docs/superpowers/v0.0.1/execution-log.md`:

```md
| <执行 Get-Date -Format 'yyyy-MM-dd HH:mm:ss' 得到的时间> | 验证 | 执行 npm run test 与 npm run build | 均通过 |
```

Use actual `Get-Date -Format 'yyyy-MM-dd HH:mm:ss'` output for the timestamp.

- [ ] **Step 8: 提交文档与验证记录**

```bash
git add README.md docs/mock-image-api.md docs/superpowers/v0.0.1/execution-log.md
git commit -m "docs: update server api deployment docs"
```

## Self-Review

- Spec coverage:
  - `/api/openai-compatible/*` 后端主路径：Task 3、Task 4、Task 6。
  - 不保留 `/api-proxy/`：Task 8、Task 9、Task 10。
  - 只后端化 OpenAI 兼容接口：Task 6、Task 7、Task 10。
  - API Key 仍由前端填写且后端不落盘：Task 3、Task 4。
  - 图片 URL 后端下载：Task 3。
  - 7-8 分钟等待的同步超时策略：Task 3、Task 6、Task 10。
  - Docker 改为 Node 生产服务：Task 9。
- Placeholder scan:
  - 本计划没有 `TBD`、`TODO`、`待定`、`按需处理`。
  - 每个任务都有明确文件、测试命令和提交点。
- Type consistency:
  - 前端配置字段统一使用 `serverApi`。
  - 后端 API 路径统一使用 `/api/openai-compatible/*`。
  - 旧 `apiProxy` 只作为迁移输入读取，不作为新字段保留。
