/**
 * StorageProvider 协议：把 AttachmentInput 解析成可发给 SDK 的形态，
 * 同时返回稳定的持久化引用（用于 transcript 历史）。
 *
 * 与 SessionStoreDriver 同样的"协议层 vs 后端实现"分离思路：
 *   - StorageProvider = kernel 公共接口
 *   - InMemoryStorage = 测试 / 本地 demo（base64 内联）
 *   - CloudBaseStorage = 生产（落 CloudBase 云存储）
 */

import type { AttachmentInput, MessagePart } from '../public/types.js'

/**
 * SDK 原生 image content block 的 source 形态（与 Anthropic Messages API 对齐）。
 * 把它定义在 kernel 内部，避免公共类型依赖 @anthropic-ai/sdk。
 */
export type ImageSource =
  | { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
  | { type: 'url'; url: string }

/**
 * StorageProvider 解析 attachment 后的统一返回结构。
 * - source：直接喂给 SDK 的 image content block
 * - messageRef：transcript 历史里 MessagePart.image.ref 字段使用
 */
export interface ResolvedAttachment {
  source: ImageSource
  mimeType: string
  /** 持久化时的稳定引用（与 MessagePart.image.ref 同形态） */
  messageRef: Extract<MessagePart, { type: 'image' }>['ref']
}

export interface StorageProvider {
  /**
   * 把 attachment 解析为可发给 SDK 的形态。
   *
   * @param att      用户传入的附件
   * @param ctx      上下文（envId / sessionId / 序号），用于派生云存储路径
   * @throws StorageError  解析失败（例如不支持的 mimeType / 上传失败）
   */
  resolveAttachment(att: AttachmentInput, ctx: ResolveContext): Promise<ResolvedAttachment>

  /**
   * 把 transcript 里的 image.ref 解析为可访问 URL（按需用于 getHistory）。
   * 当 ref 是 cos 时，重新签发临时 URL（cos URL 有过期时间）。
   *
   * MVP 阶段 MessageRecord 历史读取暂未实现（PR #4 留坑），此方法预留给将来。
   */
  resolveRefToUrl?(ref: Extract<MessagePart, { type: 'image' }>['ref']): Promise<string>
}

export interface ResolveContext {
  envId: string
  sessionId: string
  /** 同一次 send 里的附件序号（0、1、2...），用作云存储路径去重 */
  index: number
}
