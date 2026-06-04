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

const envLocalPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local')

export function loadEnv(): void {
  if (existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath })
    // eslint-disable-next-line no-console
    console.log(`[env] loaded ${envLocalPath}`)
  }
}

// Auto-load on import
loadEnv()
