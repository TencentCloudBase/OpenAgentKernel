/**
 * Credential factory: 把 AgentConfig 中的 envId + model 派生为
 * Claude Agent SDK 启动子进程所需的环境变量。
 *
 * 当前默认模型路由走 CloudBase AI gateway：
 *   - baseURL = https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase
 *   - API Key 从 ModelSpec.apiKey / CLOUDBASE_APIKEY 加载
 *
 * Claude Agent SDK 要求通过环境变量配置网关（不接受 options 直接传 baseURL/apiKey）：
 *   - `ANTHROPIC_BASE_URL`   ← CloudBase AI gateway baseURL
 *   - `ANTHROPIC_AUTH_TOKEN` ← CloudBase 环境服务端 APIKey（注意不是 `ANTHROPIC_API_KEY`）
 *   - `API_TIMEOUT_MS`       ← 长输出超时（推荐 600_000）
 *   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` ← 关闭非必要流量
 *
 * 设计原则：
 *   - 凭证流转仅在 kernel 内部，用户 API 不暴露 baseURL/apiKey 复杂度
 *   - envId 用于默认 modelGatewayBaseUrl 派生
 */

import type { ModelInput, ModelSpec } from '../public/types.js'
import { defaultCloudBaseAiBaseUrl, resolveApiKey } from '../resources/index.js'

export interface ResolvedCredential {
  /** 模型 ID，传给 SDK options.model */
  modelId: string
  /** Anthropic 协议网关 base URL，通过 ANTHROPIC_BASE_URL 注入 */
  baseUrl: string
  /** API key，通过 ANTHROPIC_AUTH_TOKEN 注入 */
  apiKey: string
  /** 凭证来源（诊断日志用） */
  apiKeySource: 'config' | 'env_tcb_api_key'
}

/**
 * 从 AgentConfig.model + AgentConfig.envId 派生出
 * Claude Agent SDK 需要的网关信息。
 *
 * @throws ResourceError 当 API Key 无法从任何来源加载时
 */
export function resolveCredential(opts: { envId: string; model: ModelInput }): ResolvedCredential {
  const { envId, model } = opts

  // 1. 模型字符串归一化为 ModelSpec
  const spec: ModelSpec = typeof model === 'string' ? { id: model } : model

  // 2. baseUrl 优先级：spec.apiBaseUrl > envId 默认派生
  const baseUrl = spec.apiBaseUrl ?? defaultCloudBaseAiBaseUrl(envId)

  // 3. apiKey 通过 resources/credential-provider 统一解析
  const { apiKey, source: apiKeySource } = resolveApiKey(spec.apiKey)

  return {
    modelId: spec.id,
    baseUrl,
    apiKey,
    apiKeySource,
  }
}
