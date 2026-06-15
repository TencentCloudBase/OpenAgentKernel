/**
 * Resource name resolver: envId → CloudBase 资源命名
 *
 * v1.0 主方案 §6.1 派生规则的最小实现。
 *
 * 模型路由走 CloudBase AI gateway：
 *   `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`
 *
 * 设计原则：
 *   - 所有派生规则集中在此模块，便于切换网关时改一处
 *   - 提供 ResourceConfig 覆盖口子，让用户能指定自定义 baseURL/集合名
 */

import type { ResourceConfig } from '../public/types.js'

/**
 * 模型网关 baseURL。
 */
export function defaultCloudBaseAiBaseUrl(envId: string): string {
  return `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`
}

/**
 * 默认 CloudBase DB 集合前缀
 */
export const DEFAULT_COLLECTION_PREFIX = 'agent'

/**
 * 默认 SCF 沙箱函数名
 */
export const DEFAULT_SANDBOX_FUNCTION_NAME = 'agent-sandbox'

export interface ResolvedResources {
  /** 模型网关 baseURL（透传给 SDK 的 ANTHROPIC_BASE_URL） */
  modelGatewayBaseUrl: string
  /** CloudBase DB - 会话集合名 */
  conversationCollection: string
  /** CloudBase DB - 消息集合名 */
  messageCollection: string
  /** SCF 沙箱函数名 */
  sandboxFunctionName: string
}

/**
 * 从 envId + 用户覆盖配置派生出所有资源命名。
 *
 * @param envId CloudBase 环境 ID（必填）
 * @param overrides 用户在 AgentConfig.resources 里的覆盖
 */
export function resolveResources(envId: string, overrides?: ResourceConfig): ResolvedResources {
  if (!envId) {
    throw new Error('envId is required for resource resolution')
  }

  return {
    modelGatewayBaseUrl: overrides?.modelGatewayBaseUrl ?? defaultCloudBaseAiBaseUrl(envId),
    conversationCollection: overrides?.conversationCollection ?? `${DEFAULT_COLLECTION_PREFIX}_conversations`,
    messageCollection: overrides?.messageCollection ?? `${DEFAULT_COLLECTION_PREFIX}_messages`,
    sandboxFunctionName: overrides?.sandboxFunctionName ?? DEFAULT_SANDBOX_FUNCTION_NAME,
  }
}
