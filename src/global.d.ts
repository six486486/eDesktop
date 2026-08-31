/// <reference types="vite/client" />

import type { DesktopAPI } from './types'

declare global {
  interface Window {
    desktopAPI?: DesktopAPI
  }
}

export {}
