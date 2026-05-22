/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_DEFAULT_API_URL?: string
  readonly VITE_DOCKER_DEPLOYMENT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
