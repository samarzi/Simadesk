/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_API_KEY: string
  readonly VITE_TG_BOT_USERNAME: string
  readonly VITE_DEV_AUTH: string
  readonly VITE_YANDEX_CLIENT_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
