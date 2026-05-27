/**
 * Credential factory: 把 AgentConfig 中的 envId + model + resources 派生为
 * Claude Agent SDK 启动子进程所需的环境变量。
 *
 * PR #3 阶段（CloudBase 网关 Anthropic 协议未完全上线）：
 *   - 模型路由走腾讯云 TokenHub（https://tokenhub.tencentmaas.com）
 *   - API Key 从 ModelSpec.apiKey / 环境变量加载
 *
 * Claude Agent SDK 要求通过环境变量配置网关（不接受 options 直接传 baseURL/apiKey）：
 *   - `ANTHROPIC_BASE_URL`   ← TokenHub baseURL
 *   - `ANTHROPIC_AUTH_TOKEN` ← TokenHub API Key（注意不是 `ANTHROPIC_API_KEY`）
 *   - `API_TIMEOUT_MS`       ← 长输出超时（TokenHub 文档推荐 600_000）
 *   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` ← 关闭非必要流量
 *
 * 设计原则：
 *   - 凭证流转仅在 kernel 内部，用户 API 不暴露 baseURL/apiKey 复杂度
 *   - envId 当前只用于资源命名派生（DB 集合 / SCF 函数等），
 *     未来切换到 CloudBase 网关时，envId 还会派生出 modelGatewayBaseUrl
 */

import type { ModelInput, ModelSpec, ResourceConfig } from '../public/types.js'
import { resolveResources, resolveApiKey } from '../resources/index.js'

export interface ResolvedCredential {
  /** 模型 ID，传给 SDK options.model */
  modelId: string
  /** Anthropic 协议网关 base URL，通过 ANTHROPIC_BASE_URL 注入 */
  baseUrl: string
  /** API key，通过 ANTHROPIC_AUTH_TOKEN 注入 */
  apiKey: string
  /** 凭证来源（诊断日志用） */
  apiKeySource: 'config' | 'env_tokenhub' | 'env_cloudbase'
}

/**
 * 从 AgentConfig.model + AgentConfig.envId + AgentConfig.resources 派生出
 * Claude Agent SDK 需要的网关信息。
 *
 * @throws ResourceError 当 API Key 无法从任何来源加载时
 */
export function resolveCredential(opts: {
  envId: string
  model: ModelInput
  resources?: ResourceConfig
}): ResolvedCredential {
  const { envId, model, resources } = opts

  // 1. 模型字符串归一化为 ModelSpec
  const spec: ModelSpec = typeof model === 'string' ? { id: model } : model

  // 2. baseUrl 优先级：spec.apiBaseUrl > resources.modelGatewayBaseUrl > envId 默认派生
  const derived = resolveResources(envId, resources)
  const baseUrl = spec.apiBaseUrl ?? derived.modelGatewayBaseUrl

  // 3. apiKey 通过 resources/credential-provider 统一解析
  const { apiKey, source: apiKeySource } = resolveApiKey(spec.apiKey)

  return {
    modelId: spec.id,
    baseUrl,
    apiKey,
    apiKeySource,
  }
}
