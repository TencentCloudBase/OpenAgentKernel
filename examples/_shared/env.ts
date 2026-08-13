/**
 * 加载 examples/config.local.json。
 *
 * 用法：在 example 顶部 `import { getEnvId, getModel, ... } from './_shared/env.js'`
 *       helper 会在首次调用时读取配置，并把 `tcbApiKey` 写入 `process.env.CLOUDBASE_APIKEY`
 *       供 SDK 默认模型网关使用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PlatformCredentials } from '@cloudbase/open-agent-kernel'

const configLocalPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config.local.json')

interface ExampleConfig {
  envId: string
  model?: string
  tcbApiKey: string
  credentials?: {
    secretId: string
    secretKey: string
    sessionToken?: string
  }
  examples?: {
    resumeConversationId?: string
    storage?: string
    imagePath?: string
    /** 多模态 example 专用；不受顶层 model（常为文本模型）影响 */
    visionModel?: string
    debug?: boolean
  }
}

let cachedConfig: ExampleConfig | null = null

function loadConfig(): ExampleConfig {
  if (cachedConfig) return cachedConfig

  if (!existsSync(configLocalPath)) {
    throw new Error(
      'examples/config.local.json is required. Copy config.example.json to config.local.json and fill in your values.',
    )
  }

  const config = JSON.parse(readFileSync(configLocalPath, 'utf8')) as ExampleConfig

  if (!config.envId) {
    throw new Error('config.local.json: envId is required')
  }
  if (!config.tcbApiKey) {
    throw new Error('config.local.json: tcbApiKey is required')
  }

  process.env.CLOUDBASE_APIKEY = config.tcbApiKey
  if (config.examples?.debug === true) {
    process.env.OAK_DEBUG = '1'
  }

  cachedConfig = config
  // eslint-disable-next-line no-console
  console.log('[env] loaded config.local.json')
  return config
}

export function loadEnv(): void {
  loadConfig()
}

export function getEnvId(): string {
  return loadConfig().envId
}

export function getModel(defaultModel = 'glm-5.1'): string {
  return loadConfig().model ?? defaultModel
}

/**
 * example 用的模型：优先环境变量覆盖，否则读 `config.local.json` 的 `model`。
 *
 * - `OAK_EXAMPLE_MODEL_API_KEY` 存在时走自带 endpoint（`id` 仍回退到 config.model）
 * - `OAK_EXAMPLE_MODEL_ID` 覆盖模型 ID
 */
export function getExampleModel(defaultModel = 'glm-5.1'): string | { id: string; apiKey: string; apiBaseUrl?: string } {
  const customModelId = process.env.OAK_EXAMPLE_MODEL_ID
  const customApiKey = process.env.OAK_EXAMPLE_MODEL_API_KEY
  const customApiBaseUrl = process.env.OAK_EXAMPLE_MODEL_API_BASE_URL
  const fallbackId = customModelId ?? getModel(defaultModel)
  if (customApiKey) {
    return {
      id: fallbackId,
      apiKey: customApiKey,
      ...(customApiBaseUrl ? { apiBaseUrl: customApiBaseUrl } : {}),
    }
  }
  return fallbackId
}

/** 视觉 / 多模态 example 专用模型（忽略 config.model，避免误用文本模型） */
export function getVisionModel(defaultModel = 'glm-5v-turbo'): string {
  const visionModel = loadConfig().examples?.visionModel
  return visionModel && visionModel.length > 0 ? visionModel : defaultModel
}

/** config.example.json 占位值 / 空串，视为「未配置有效 CAM」。 */
function isUsableCamSecret(value: string | undefined): value is string {
  if (!value || !value.trim()) return false
  const v = value.trim()
  if (/^AKIDx+$/i.test(v)) return false
  if (/^x+$/i.test(v)) return false
  if (v.includes('xxxxxxxx')) return false
  return true
}

/**
 * 读取 CAM 平台凭证；缺省或占位符时返回 undefined（不抛错）。
 * 调用方可再回退到 `accessKey` / `CLOUDBASE_APIKEY`。
 */
export function tryGetPlatformCredentials(): PlatformCredentials | undefined {
  const config = loadConfig()
  const credentials = config.credentials
  if (!isUsableCamSecret(credentials?.secretId) || !isUsableCamSecret(credentials?.secretKey)) {
    return undefined
  }

  return {
    envId: config.envId,
    secretId: credentials.secretId.trim(),
    secretKey: credentials.secretKey.trim(),
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
  }
}

export function getPlatformCredentials(): PlatformCredentials {
  const credentials = tryGetPlatformCredentials()
  if (!credentials) {
    throw new Error('config.local.json: credentials.secretId and credentials.secretKey are required')
  }
  return credentials
}

/**
 * CAM 可用则用 CAM；否则用 `tcbApiKey` → `credentials.accessKey`（kernel 会换临时 CAM）。
 * 两者都缺时抛错。
 */
export function getPlatformCredentialsOrApiKey(): PlatformCredentials {
  const cam = tryGetPlatformCredentials()
  if (cam) return cam

  const config = loadConfig()
  const accessKey = process.env.CLOUDBASE_APIKEY ?? config.tcbApiKey
  if (!accessKey) {
    throw new Error(
      'config.local.json: need usable credentials.secretId/secretKey, or tcbApiKey (CLOUDBASE_APIKEY fallback)',
    )
  }

  // eslint-disable-next-line no-console
  console.log('[env] CAM credentials missing/placeholder; falling back to credentials.accessKey (tcbApiKey)')
  return { envId: config.envId, accessKey }
}

export function getResumeConversationId(): string | undefined {
  const id = loadConfig().examples?.resumeConversationId
  return id && id.length > 0 ? id : undefined
}

export function getExampleStorage(): string | undefined {
  const storage = loadConfig().examples?.storage
  return storage && storage.length > 0 ? storage : undefined
}

export function getExampleImagePath(): string | undefined {
  const imagePath = loadConfig().examples?.imagePath
  return imagePath && imagePath.length > 0 ? imagePath : undefined
}

export function getSandboxApiKey(): string {
  loadConfig()
  const apiKey = process.env.CLOUDBASE_APIKEY
  if (!apiKey) {
    throw new Error('config.local.json: tcbApiKey is required')
  }
  return apiKey
}
