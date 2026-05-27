/**
 * Resource name resolver: envId → CloudBase 资源命名
 *
 * v1.0 主方案 §6.1 派生规则的最小实现。
 *
 * 当前阶段（CloudBase 网关 Anthropic 协议未完全上线）：
 *   - 模型路由暂时走 **腾讯云 TokenHub**（https://tokenhub.tencentmaas.com）
 *   - envId 仅用于派生 CloudBase DB 集合名 / SCF 沙箱函数名
 *   - 等 CloudBase 网关 Anthropic 协议上线后，会切换到
 *     `https://${envId}.api.tcloudbasegateway.com/v1/anthropic`，
 *     用户代码零改动
 *
 * 设计原则：
 *   - 所有派生规则集中在此模块，便于切换网关时改一处
 *   - 提供 ResourceConfig 覆盖口子，让用户能指定自定义 baseURL/集合名
 */

import type { ResourceConfig } from '../public/types.js'

/**
 * 模型网关 baseURL —— 当前阶段固定走 TokenHub Anthropic 协议端点。
 *
 * TokenHub 文档：https://cloud.tencent.com/document/product/1823/130079
 *
 * @internal 等 CloudBase 网关上线后，改为 envId 派生：
 *   `https://${envId}.api.tcloudbasegateway.com/v1/anthropic`
 */
export const DEFAULT_TOKENHUB_BASE_URL = 'https://tokenhub.tencentmaas.com'

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
export function resolveResources(
  envId: string,
  overrides?: ResourceConfig,
): ResolvedResources {
  if (!envId) {
    throw new Error('envId is required for resource resolution')
  }

  return {
    modelGatewayBaseUrl: overrides?.modelGatewayBaseUrl ?? DEFAULT_TOKENHUB_BASE_URL,
    conversationCollection:
      overrides?.conversationCollection ?? `${DEFAULT_COLLECTION_PREFIX}_conversations`,
    messageCollection:
      overrides?.messageCollection ?? `${DEFAULT_COLLECTION_PREFIX}_messages`,
    sandboxFunctionName: overrides?.sandboxFunctionName ?? DEFAULT_SANDBOX_FUNCTION_NAME,
  }
}
