/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPA_URL: string
  readonly VITE_SUPA_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
