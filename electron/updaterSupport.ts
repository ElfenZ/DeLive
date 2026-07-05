import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'

const APP_UPDATE_CONFIG_FILE = 'app-update.yml'
type ElectronAutoUpdater = typeof import('electron-updater').autoUpdater
const requireElectronUpdater = createRequire(__filename)
let cachedAutoUpdater: ElectronAutoUpdater | null = null

export function getAppUpdateConfigPath(): string {
  return path.join(process.resourcesPath, APP_UPDATE_CONFIG_FILE)
}

export function hasAppUpdateConfig(): boolean {
  try {
    return fs.existsSync(getAppUpdateConfigPath())
  } catch {
    return false
  }
}

export function isAutoUpdateSupported(): boolean {
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return false
  }

  return hasAppUpdateConfig()
}

export function isMissingAppUpdateConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(APP_UPDATE_CONFIG_FILE) || message.includes('UpdateConfigPath')
}

export function getAutoUpdater(): ElectronAutoUpdater {
  if (!cachedAutoUpdater) {
    const updaterModule = requireElectronUpdater('electron-updater') as typeof import('electron-updater')
    cachedAutoUpdater = updaterModule.autoUpdater
  }

  return cachedAutoUpdater
}
