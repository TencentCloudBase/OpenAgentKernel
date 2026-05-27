/**
 * Credential provider: 加载模型网关 API Key
 *
 * 当前阶段（PR #3）走 **腾讯云 TokenHub**（普通 API Key，按量付费）：
 *   - TokenHub 接受 Anthropic 协议（baseURL = https://tokenhub.tencentmaas.com）
 *   - 认证通过 Claude SDK 的 `ANTHROPIC_AUTH_TOKEN` 环境变量
 *   - API Key 在腾讯云控制台 TokenHub → API Key 管理页面创建（格式 sk-xxx）
 *
 * 凭证来源优先级（高 → 低）：
 *   1. ModelSpec.apiKey（用户在 AgentConfig.model 里直传）
 *   2. process.env.TENCENTCLOUD_TOKENHUB_API_KEY（**当前阶段推荐**，描述准确）
 *   3. process.env.CLOUDBASE_API_KEY（保留为未来 CloudBase 网关上线后的主名，过渡期兼容）
 *   4. 抛错（不再用占位符，避免误用）
 *
 * 未来切换说明：
 *   等 CloudBase 网关 Anthropic 协议上线后：
 *   - 主推环境变量切换为 CLOUDBASE_API_KEY（envId 维度的 CloudBase 控制台 key）
 *   - 凭证派生改为通过 @cloudbase/manager-node 拉临时凭证
 *   - 接口签名不变，用户感知零变化
 */

import { ResourceError } from '../internal/errors.js'

export interface ResolvedApiKey {
  /** 透传给 SDK 的 ANTHROPIC_AUTH_TOKEN 环境变量值 */
  apiKey: string
  /** 凭证来源（用于诊断日志） */
  source: 'config' | 'env_tokenhub' | 'env_cloudbase'
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

  // 2. 当前阶段主推：TENCENTCLOUD_TOKENHUB_API_KEY（TokenHub 控制台创建的 sk-xxx）
  const tokenhubKey = process.env.TENCENTCLOUD_TOKENHUB_API_KEY
  if (typeof tokenhubKey === 'string' && tokenhubKey.length > 0) {
    return { apiKey: tokenhubKey, source: 'env_tokenhub' }
  }

  // 3. 过渡期兼容：CLOUDBASE_API_KEY（未来 CloudBase 网关上线后会切为主名）
  const cloudbaseKey = process.env.CLOUDBASE_API_KEY
  if (typeof cloudbaseKey === 'string' && cloudbaseKey.length > 0) {
    return { apiKey: cloudbaseKey, source: 'env_cloudbase' }
  }

  throw new ResourceError(
    'No API key found. Set one of:\n' +
      '  - process.env.TENCENTCLOUD_TOKENHUB_API_KEY (recommended, current stage)\n' +
      '  - process.env.CLOUDBASE_API_KEY (forward-compatible alias)\n' +
      '  - AgentConfig.model.apiKey (programmatic)\n' +
      '\n' +
      'Get a TokenHub API key at: https://console.cloud.tencent.com/tokenhub',
  )
}
