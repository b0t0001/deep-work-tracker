import { ElectronAPI } from '@electron-toolkit/preload'
import type { DeepWorkApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: DeepWorkApi
  }
}
