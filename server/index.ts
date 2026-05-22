import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readServerConfig } from './config.js'
import { normalizeErrorMessage, toHttpError } from './errors.js'
import { createApp } from './http.js'

const config = readServerConfig()
const app = createApp(config)

/** 启动 Node HTTP 服务，同时承载 API 和前端静态文件。 */
function startServer(): void {
  const server = createServer(async (req, res) => {
    try {
      const request = createWebRequest(req)
      const response = await app.fetch(request)
      await writeWebResponse(res, response, req.method === 'HEAD')
    } catch (error) {
      await writeUnexpectedError(res, error)
    }
  })

  server.listen(config.port, config.host, () => {
    console.log(`gpt-image-playground server listening on http://${config.host}:${config.port}`)
  })
}

/** 将 Node IncomingMessage 转换为 Web Request。 */
function createWebRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: createWebHeaders(req),
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req as unknown as BodyInit
    init.duplex = 'half'
  }

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
  if (!omitBody && response.body) {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  }
  res.end()
}

/** 将 Web Headers 转成 Node writeHead 可接收的普通对象。 */
function createNodeHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  return headers
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

startServer()
