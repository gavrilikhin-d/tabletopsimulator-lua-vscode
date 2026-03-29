/**
 * @file API Manager
 * This file manages the API that is used for completion, stuff like downloading the latest API, and
 * loading it from local storage.
 */

import L from '@/i18n'
import * as LSS from '@/utils/LocalStorageService'
import fetch from 'node-fetch'
import { quickStatus } from '@/vscode/statusBarManager'
import { join } from 'path'
import FileManager from '@/vscode/fileManager'
import { compare } from 'compare-versions'
import { logger } from '@/vscode/logger'

interface Basic {
  name: string
  type: string
  description?: string
}

interface Section extends Basic {
  description: string
  kind: string
  url: string
}

interface Parameter extends Basic {
  parameters?: Parameter[]
}

export interface Member extends Section {
  parameters?: Parameter[]
  return_table?: Parameter[]
  return_table_items?: Parameter[]
}

export interface LuaAPI {
  sections: Record<string, Section[]>
  version: string
  behaviors: string[]
}

export async function loadApi(): Promise<LuaAPI> {
  const defaultDownloadedApiPath = 'completion/lua.json'
  const extPath = LSS.get<string>('extensionPath')
  if (extPath === undefined) {
    throw new Error('Extension Path not found')
  }
  const shippedApiFs = new FileManager(join(extPath, 'assets/apis/luaApi.json'), false)
  const shippedApi = JSON.parse(await shippedApiFs.read()) as LuaAPI

  try {
    const res = await fetch(L.urls.luaCompletionApi())
    const remoteApi = (await res.json()) as LuaAPI
    if (compare(remoteApi.version, shippedApi.version, '>')) {
      await LSS.write(defaultDownloadedApiPath, JSON.stringify(remoteApi, undefined, 2))
      logger.debug(`TTS Lua API Updated to ${remoteApi.version}`)
      return remoteApi
    }
  } catch {
    quickStatus(`Lua API Download Failed`)
  }

  await LSS.write(defaultDownloadedApiPath, JSON.stringify(shippedApi, undefined, 2))
  logger.debug(`TTS Lua API Loaded from Extension: ${shippedApi.version}`)
  return shippedApi
}
