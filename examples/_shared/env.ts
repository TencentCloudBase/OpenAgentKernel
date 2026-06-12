/**
 * 加载 examples/.env.local 到 process.env。
 *
 * 用法1：在 example 顶部 `import './_shared/env.js'`，之后正常 `process.env.XXX` 即可。
 *        （自动在 module load 时执行）
 *
 * 用法2：显式调用 `loadEnv()`。
 *
 * 加载规则（dotenv 默认）：
 *   - 已 export 到 process.env 的真实环境变量优先（不被覆盖）
 *   - .env.local 不存在时静默跳过（不报错，避免妨碍纯 shell export 的用法）
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as dotenv from 'dotenv'
import type { PlatformCredentials } from '@cloudbase/open-agent-kernel'

const envLocalPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local')

export function loadEnv(): void {
  if (existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath })
    // eslint-disable-next-line no-console
    console.log('[env] loaded local example env')
  }
}

// Auto-load on import
loadEnv()

export function getEnvId(): string {
  const envId = process.env.TCB_ENV_ID
  if (!envId) {
    throw new Error('TCB_ENV_ID is required (set it in examples/.env.local)')
  }
  return envId
}

export function getPlatformCredentials(): PlatformCredentials {
  const envId = getEnvId()
  const secretId = process.env.TENCENTCLOUD_SECRETID ?? process.env.TCB_SECRET_ID
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY ?? process.env.TCB_SECRET_KEY
  const sessionToken = process.env.TENCENTCLOUD_SESSIONTOKEN ?? process.env.TCB_TOKEN

  if (!secretId || !secretKey) {
    throw new Error('TENCENTCLOUD_SECRETID and TENCENTCLOUD_SECRETKEY are required')
  }

  return {
    envId,
    secretId,
    secretKey,
    ...(sessionToken ? { sessionToken } : {}),
  }
}

export function getSandboxApiKey(): string {
  const apiKey = process.env.TCB_API_KEY
  if (!apiKey) {
    throw new Error('TCB_API_KEY is required for AgsStatefulSandbox examples')
  }
  return apiKey
}
