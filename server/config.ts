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
