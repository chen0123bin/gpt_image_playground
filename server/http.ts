import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { callOpenAICompatibleFromServer, type ServerOpenAIRequest } from './openaiCompatible.js'
import { normalizeErrorMessage, toHttpError } from './errors.js'

const OPENAI_COMPATIBLE_PREFIX = '/api/openai-compatible/'
const OPENAI_COMPATIBLE_ENDPOINTS = ['images/generations', 'images/edits', 'responses'] as const
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

type OpenAICompatibleEndpoint = typeof OPENAI_COMPATIBLE_ENDPOINTS[number]

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
  if (url.pathname.startsWith(OPENAI_COMPATIBLE_PREFIX)) {
    return handleOpenAICompatibleRoute(request, url.pathname)
  }
  if (url.pathname.startsWith('/api/')) {
    return jsonError(404, 'NOT_FOUND', '接口不存在')
  }
  return serveStatic(url.pathname, config, request.method === 'HEAD')
}

/** 处理 OpenAI 兼容接口服务端 API 路由。 */
async function handleOpenAICompatibleRoute(request: Request, pathname: string): Promise<Response> {
  const endpoint = pathname.slice(OPENAI_COMPATIBLE_PREFIX.length)
  if (!isOpenAICompatibleEndpoint(endpoint)) {
    return jsonError(404, 'NOT_FOUND', '接口不存在')
  }

  if (request.method !== 'POST') {
    return jsonError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST 请求')
  }

  try {
    const payload = await readJsonBody(request)
    const result = await callOpenAICompatibleFromServer(payload, endpoint, request.signal)
    return jsonResponse(result)
  } catch (error) {
    const httpError = toHttpError(error)
    return jsonError(httpError.status, httpError.code, httpError.message)
  }
}

/** 读取 JSON 请求体，并把解析失败稳定映射为 400 错误。 */
async function readJsonBody(request: Request): Promise<ServerOpenAIRequest> {
  try {
    return await request.json() as ServerOpenAIRequest
  } catch {
    throw {
      status: 400,
      code: 'INVALID_JSON',
      message: '请求 JSON 格式无效',
    }
  }
}

/** 判断路径尾段是否为当前支持的 OpenAI 兼容端点。 */
function isOpenAICompatibleEndpoint(value: string): value is OpenAICompatibleEndpoint {
  return OPENAI_COMPATIBLE_ENDPOINTS.includes(value as OpenAICompatibleEndpoint)
}

/** 返回 JSON 响应。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** 返回统一格式的 JSON 错误响应。 */
function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse({
    error: {
      message: normalizeErrorMessage(message),
      code,
      status,
    },
  }, status)
}

/** 返回静态文件，找不到具体文件时回退到 SPA 的 index.html。 */
async function serveStatic(pathname: string, config: AppConfig, omitBody: boolean): Promise<Response> {
  const staticRoot = resolve(config.staticDir)
  const indexPath = resolve(staticRoot, 'index.html')
  const requestedPath = resolveStaticPath(staticRoot, pathname)
  const filePath = requestedPath && await isFile(requestedPath) ? requestedPath : indexPath
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

  if (!isPathInside(staticRoot, filePath) || !await isFile(filePath)) {
    return new Response('Not found', { status: 404 })
  }

  if (omitBody) {
    return new Response(null, {
      headers: { 'Content-Type': contentType },
    })
  }

  if (extname(filePath).toLowerCase() === '.js') {
    const content = await readFile(filePath, 'utf8')
    return new Response(replaceRuntimePlaceholders(content, config), {
      headers: { 'Content-Type': contentType },
    })
  }

  return new Response(await readFile(filePath), {
    headers: { 'Content-Type': contentType },
  })
}

/** 替换前端构建产物中的运行时环境占位符。 */
function replaceRuntimePlaceholders(content: string, config: AppConfig): string {
  return content
    .replaceAll('__VITE_DEFAULT_API_URL_PLACEHOLDER__', config.defaultApiUrl)
    .replaceAll('__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__', 'true')
}

/** 将 URL 路径解析为静态目录内的候选文件路径。 */
function resolveStaticPath(staticRoot: string, pathname: string): string | undefined {
  const decodedPathname = safeDecodePathname(pathname)
  const relativePath = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^[/\\]+/, '')
  const filePath = resolve(staticRoot, relativePath)

  return isPathInside(staticRoot, filePath) ? filePath : undefined
}

/** 安全解码 URL 路径，畸形路径按 SPA 路由处理。 */
function safeDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return '/'
  }
}

/** 判断文件路径是否仍位于静态根目录内，避免路径穿越。 */
function isPathInside(root: string, filePath: string): boolean {
  const relativePath = relative(root, filePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

/** 判断路径是否为普通文件，文件不存在时返回 false。 */
async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}
