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
