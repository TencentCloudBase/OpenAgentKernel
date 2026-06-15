/**
 * Credential provider: 加载模型网关 API Key
 *
 * 当前默认走 CloudBase AI gateway：
 *   - baseURL = https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase
 *   - 认证通过 Claude SDK 的 `ANTHROPIC_AUTH_TOKEN` 环境变量
 *   - API Key 使用 CloudBase 环境的服务端 APIKey
 *
 * 凭证来源优先级（高 → 低）：
 *   1. ModelSpec.apiKey（用户在 AgentConfig.model 里直传）
 *   2. process.env.TCB_API_KEY（CloudBase 环境服务端 APIKey，推荐；也可复用于 AGS 数据面）
 *   3. process.env.CLOUDBASE_API_KEY（兼容别名）
 *   4. 抛错（不再用占位符，避免误用）
 */

import { ResourceError } from '../internal/errors.js'

export interface ResolvedApiKey {
  /** 透传给 SDK 的 ANTHROPIC_AUTH_TOKEN 环境变量值 */
  apiKey: string
  /** 凭证来源（用于诊断日志） */
  source: 'config' | 'env_tcb_api_key' | 'env_cloudbase'
}

/**
 * 解析 API Key。
 *
 * @param explicitKey 用户在 AgentConfig.model.apiKey 直传的 key（最高优先级）
 * @throws ResourceError 当所有来源都拿不到 key 时
 */
export function resolveApiKey(explicitKey?: string): ResolvedApiKey {
  // 1. 用户直传
  if (typeof explicitKey === 'string' && explicitKey.length > 0) {
    return { apiKey: explicitKey, source: 'config' }
  }

  // 2. 当前主推：CloudBase 环境服务端 APIKey（复用 examples 既有 TCB_API_KEY）
  const tcbApiKey = process.env.TCB_API_KEY
  if (typeof tcbApiKey === 'string' && tcbApiKey.length > 0) {
    return { apiKey: tcbApiKey, source: 'env_tcb_api_key' }
  }

  // 3. 兼容别名：CloudBase 环境服务端 APIKey
  const cloudbaseKey = process.env.CLOUDBASE_API_KEY
  if (typeof cloudbaseKey === 'string' && cloudbaseKey.length > 0) {
    return { apiKey: cloudbaseKey, source: 'env_cloudbase' }
  }

  throw new ResourceError(
    'No API key found. Set one of:\n' +
      '  - process.env.TCB_API_KEY (CloudBase environment server APIKey, recommended)\n' +
      '  - process.env.CLOUDBASE_API_KEY (compatible alias)\n' +
      '  - AgentConfig.model.apiKey (programmatic)\n' +
      '\n' +
      'Get a CloudBase server APIKey from the CloudBase environment settings.',
  )
}
