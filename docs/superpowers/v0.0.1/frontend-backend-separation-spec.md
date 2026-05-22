# 前后端分离改造设计

> 版本：v0.0.1
> 阶段：spec
> 更新时间：2026-05-22 13:52:54
> 时间格式：yyyy-MM-dd HH:mm:ss

## 背景

当前项目是 Vite + React 静态前端应用。图片生成请求主要在浏览器中通过 `fetch` 直接访问 OpenAI 兼容接口或其他图片服务商，因此会受到浏览器 CORS 限制。项目已有本地开发代理与 Docker Nginx `/api-proxy/` 方案，但它们更偏向透明转发，不利于后续扩展统一鉴权、任务队列、服务商适配、错误归一化和安全策略。

本版本将项目演进为同仓库前后端分离架构：前端继续负责界面、配置、历史记录和任务展示；新增 Node.js 后端作为 API 能力层，前端调用自有后端，后端再调用真实图片服务商。第一阶段只支持 OpenAI 兼容接口，不纳入 fal.ai 或自定义服务商。

## 目标

- 浏览器不再直接请求外部图片 API，避免外部服务商 CORS 限制。
- 前端请求统一走项目后端 `/api/openai-compatible/*` 接口。
- 第一阶段继续保留现有“用户在前端填写 API URL、API Key、模型”的使用方式。
- 后端单次请求内使用前端传入的 API Key，不保存、不写日志、不落盘。
- 后端统一处理 OpenAI 兼容接口的生成、编辑和 Responses API 请求。
- 后端负责下载 API 返回的远端图片 URL，并返回前端可直接保存或展示的数据，解决“接口成功但图片链接跨域下载失败”的问题。
- 后端请求超时允许覆盖 7-8 分钟图片生成场景，并将超时、上游失败和图片下载失败转换为清晰错误。
- 移除现有 `/api-proxy/` 代理服务，避免同时维护两套跨域解决方案。
- 第一阶段只保留 OpenAI 兼容接口能力，不实现 fal.ai 和自定义服务商后端化。
- 保持现有前端历史记录、IndexedDB、本地多配置体验尽量不变。

## 非目标

- 不新增用户系统、登录鉴权或多租户账号。
- 不引入数据库。
- 不把 API Key 改为后端环境变量统一管理。
- 不重写全部 UI。
- 不实现后端任务队列、轮询任务状态或结果持久化。
- 不在本版本后端化 fal.ai。
- 不在本版本后端化自定义 HTTP 服务商。
- 不保留现有 `/api-proxy/` 代理服务。

## 推荐架构

```text
React/Vite 前端
  -> Node.js 后端 /api/openai-compatible/*
    -> OpenAI 兼容接口
```

同仓库拆分建议：

```text
src/                     # 现有前端
server/                  # 新增 Node.js 后端
  index.ts               # 服务入口
  routes/                # HTTP 路由
  services/              # 服务商请求与结果处理
  shared/                # 后端内部共享类型与工具
```

第一阶段后端保持轻量，不建立独立插件系统，不引入任务队列。与现有前端类型重复的地方优先提取最小共享类型，避免为了抽象而大规模搬迁代码。

## API 边界

前端新增或调整为“服务端 API 模式”。开启后，OpenAI 兼容接口请求发送到同源后端，不再直连外部图片 API，也不再使用 `/api-proxy/`：

```text
POST /api/openai-compatible/images/generations
POST /api/openai-compatible/images/edits
POST /api/openai-compatible/responses
```

请求体包含当前前端已有任务所需字段：

```json
{
  "profile": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-image-2",
    "apiMode": "images",
    "timeout": 600,
    "responseFormatB64Json": false,
    "codexCli": false
  },
  "prompt": "提示词",
  "params": {
    "size": "1024x1024",
    "quality": "auto",
    "output_format": "png",
    "moderation": "auto",
    "n": 1
  },
  "inputImageDataUrls": [],
  "maskDataUrl": null
}
```

响应沿用前端当前需要的核心结构：

```json
{
  "images": ["data:image/png;base64,..."],
  "actualParams": {},
  "actualParamsList": [],
  "revisedPrompts": [],
  "rawImageUrls": []
}
```

错误响应统一为：

```json
{
  "error": {
    "message": "可展示给用户的错误",
    "code": "UPSTREAM_ERROR",
    "status": 502
  }
}
```

## 数据流

1. 用户在前端选择配置并提交图片任务。
2. 前端按现有逻辑整理 prompt、参数、输入图和遮罩图。
3. 前端调用项目后端 `/api/openai-compatible/*`。
4. 后端校验基础字段，拒绝缺少 `baseUrl`、`apiKey`、`model` 或 `prompt` 的请求。
5. 后端组装真实 OpenAI 兼容接口请求，并携带 `Authorization: Bearer <apiKey>`。
6. 上游返回 base64 图片时，后端直接归一化后返回。
7. 上游返回图片 URL 时，后端下载图片并转换为 data URL 后返回。
8. 前端继续按现有任务结果流程保存历史记录和展示图片。

## 长时间请求处理

图片生成最长可能等待 7-8 分钟。第一阶段不使用后端任务队列，仍采用同步服务端 API 请求，但需要明确超时策略：

- 前端到后端的请求超时时间应覆盖 7-8 分钟生成场景，默认建议不低于 10 分钟。
- 后端到上游 API 的请求超时时间由前端配置中的 `timeout` 控制，并设置合理上限，例如 15 分钟。
- 后端下载图片 URL 时使用独立超时，避免结果图片下载长期阻塞。
- 如果上游超时，后端返回明确的超时错误，而不是让浏览器显示模糊的网络失败。
- 用户取消前端任务时，前端应中断当前后端请求，后端同步中断仍在执行的上游请求。

## 安全与隐私

- 第一阶段 API Key 仍由用户在前端输入，并随单次请求传到后端。
- 后端不得将 API Key 写入日志、错误响应、历史文件或缓存。
- 后端错误信息需要过滤 Authorization、Cookie 等敏感请求头。
- 后端只允许请求用户配置的 `baseUrl` 所指向的 API，不额外开放任意 URL 抓取接口。
- 图片 URL 下载只服务于上游 API 响应中的结果链接，不提供通用公网代理接口。

## 与现有代理的关系

现有 `/api-proxy/` 不再保留。新实现的主路径是 `/api/openai-compatible/*`，所有 OpenAI 兼容接口的生成、编辑和 Responses API 请求都通过服务端 API 模式进入后端。

本版本应移除或停止使用：

- `src/lib/devProxy.ts`
- `dev-proxy.config.json`
- Docker Nginx `/api-proxy/` 配置

如果部分代码仍需要 URL 规范化工具，应将通用函数迁移到新的 API 客户端或共享工具中，不保留 `/api-proxy/` 语义。

## 开发与部署

本地开发建议提供两个进程：

```text
npm run dev:web       # Vite 前端
npm run dev:server    # Node 后端
npm run dev           # 同时启动前端和后端
```

生产部署建议：

- Node 后端提供静态文件托管能力，直接服务 Vite 构建产物，并承载 `/api/openai-compatible/*`。
- Docker 镜像启动 Node 服务，而不是仅启动 Nginx 静态服务。
- 如果仍使用 Nginx，只让 Nginx 反向代理到 Node 后端，不再配置 `/api-proxy/` 上游转发。

## 测试策略

- 为后端 URL 构建、请求校验、取消请求、错误归一化、图片 URL 转 data URL 添加单元测试。
- 为前端 API 调用分支添加测试，确认服务端 API 模式下请求 `/api/openai-compatible/*`。
- 为 fal.ai 和自定义服务商添加回归测试，确认它们不走本版本新增后端路径。
- 保留现有 `npm run test` 作为回归入口。
- 后续实现完成后执行 `npm run test` 和 `npm run build`。

## 成功标准

- 本地开发时，前端提交图片任务后不再直接请求外部图片 API。
- 浏览器网络面板中 OpenAI 兼容接口图片生成请求指向同源后端 `/api/openai-compatible/*`。
- 使用无 CORS 响应头的模拟 API 时，API 请求阶段不再被浏览器 CORS 拦截。
- 上游返回图片 URL 且图片服务器不允许浏览器跨域时，后端仍能下载并返回 data URL。
- 模拟 7-8 分钟长耗时图片生成时，服务端 API 模式能维持请求直到成功或返回明确超时错误。
- 项目不再依赖 `/api-proxy/` 代理服务，相关配置和文档不再作为推荐路径出现。
- fal.ai 和自定义服务商不进入本版本后端化范围。
- 现有前端历史记录、任务展示和基础参数配置行为保持可用。
- `npm run test` 和 `npm run build` 通过。

## 后续扩展方向

- 将 API Key 移入后端环境变量或服务端密钥管理。
- 增加用户鉴权与访问控制。
- 增加队列、限流和任务状态持久化。
- 将 fal.ai、自定义服务商逐步纳入后端 provider adapter。
- 增加服务端审计日志，但默认不记录 prompt、API Key 和图片原始内容。
