/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Convex HTTP actions deployment (e.g. https://xxx.convex.site). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
