import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { readServerConfig } from './config.js'
import { normalizeErrorMessage, toHttpError } from './errors.js'
import { createApp } from './http.js'

export interface NodeApp {
  fetch: (request: Request) => Promise<Response>
}

const config = readServerConfig()
const defaultApp = createApp(config)

/** 启动 Node HTTP 服务，同时承载 API 和前端静态文件。 */
function startServer(): void {
  const server = createNodeServer(defaultApp)

  server.listen(config.port, config.host, () => {
    console.log(`gpt-image-playground server listening on http://${config.host}:${config.port}`)
  })
}

/** 创建 Node HTTP 服务，便于生产入口和测试共用同一套桥接逻辑。 */
export function createNodeServer(app: NodeApp = defaultApp): Server {
  return createServer(async (req, res) => {
    try {
      const request = createWebRequest(req, res)
      const response = await app.fetch(request)
      await writeWebResponse(res, response, req.method === 'HEAD')
    } catch (error) {
      await writeUnexpectedError(res, error)
    }
  })
}

/** 将 Node IncomingMessage 转换为 Web Request。 */
function createWebRequest(req: IncomingMessage, res: ServerResponse): Request {
  const controller = new AbortController()
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: createWebHeaders(req),
    signal: controller.signal,
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req as unknown as BodyInit
    init.duplex = 'half'
  }

  const abortRequest = () => {
    controller.abort(new DOMException('请求已取消', 'AbortError'))
  }
  req.once('aborted', abortRequest)
  res.once('close', () => {
    if (!res.writableEnded) abortRequest()
  })

  return new Request(url, init)
}

/** 从 Node 请求头创建 Web Headers，跳过未定义的头值。 */
function createWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item))
      continue
    }
    if (value !== undefined) headers.set(name, value)
  }
  return headers
}

/** 将 Web Response 写回 Node ServerResponse。 */
async function writeWebResponse(res: ServerResponse, response: Response, omitBody: boolean): Promise<void> {
  res.writeHead(response.status, createNodeHeaders(response))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  if (!omitBody && response.body) {
    reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writeChunk(res, value)
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
  }
  res.end()
}

/** 将 Web Headers 转成 Node writeHead 可接收的普通对象。 */
function createNodeHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  const setCookie = getSetCookieHeaders(response.headers)
  if (setCookie.length) headers['set-cookie'] = setCookie
  return headers
}

/** 读取多个 Set-Cookie 响应头，避免 Node 写响应时把它们折叠成一个头。 */
function getSetCookieHeaders(headers: Headers): string[] {
  const headersWithCookies = headers as Headers & { getSetCookie?: () => string[] }
  return headersWithCookies.getSetCookie?.() ?? []
}

/** 写入响应块，并在背压或连接异常时等待对应事件。 */
async function writeChunk(res: ServerResponse, value: Uint8Array): Promise<void> {
  if (res.destroyed) throw new Error('响应连接已关闭')
  if (res.write(value)) return

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('响应连接已关闭'))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onError)
  })
}

/** 将入口层未捕获异常写为脱敏后的 500 JSON 响应。 */
async function writeUnexpectedError(res: ServerResponse, error: unknown): Promise<void> {
  if (res.headersSent) {
    res.end()
    return
  }

  const httpError = toHttpError(error)
  const payload = JSON.stringify({
    error: {
      message: normalizeErrorMessage(httpError),
      code: 'INTERNAL_ERROR',
      status: 500,
    },
  })

  res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
}
