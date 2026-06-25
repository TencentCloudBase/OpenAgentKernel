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

/** 视觉 / 多模态 example 专用模型（忽略 config.model，避免误用文本模型） */
export function getVisionModel(defaultModel = 'glm-5v-turbo'): string {
  const visionModel = loadConfig().examples?.visionModel
  return visionModel && visionModel.length > 0 ? visionModel : defaultModel
}

export function getPlatformCredentials(): PlatformCredentials {
  const config = loadConfig()
  const credentials = config.credentials

  if (!credentials?.secretId || !credentials.secretKey) {
    throw new Error('config.local.json: credentials.secretId and credentials.secretKey are required')
  }

  return {
    envId: config.envId,
    secretId: credentials.secretId,
    secretKey: credentials.secretKey,
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
  }
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
