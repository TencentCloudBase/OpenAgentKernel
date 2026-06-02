/**
 * prompt-builder：把 kernel 的 SessionInput（含 attachments）翻译为
 * Claude Agent SDK 接受的 prompt 形态。
 *
 * SDK query() 的 prompt 字段支持两种形态：
 *   - string                                     → 纯文本场景
 *   - AsyncIterable<SDKUserMessage>              → 多模态 / 流式输入场景
 *
 * 本模块统一走第二种形态（AsyncIterable），让上层逻辑收敛：
 *   - 纯文本：构造一条只有 text block 的 SDKUserMessage
 *   - 多模态：构造一条含 text + image blocks 的 SDKUserMessage
 *   - 未来扩展（流式、tool_result 回灌）也走同一个抽象
 *
 * 性能：纯文本场景比直接传 string 多包一层 generator（开销 ~0），
 *      为统一性付出的代价可忽略。
 */

import type { AttachmentInput, SessionInput } from '../public/types.js'
import { InvalidConfigError } from '../internal/errors.js'
import type { ImageSource, ResolvedAttachment, StorageProvider } from '../storage/types.js'

/**
 * SDKUserMessage 的最小子集（只用 message 字段，其他可选字段不填）。
 * 类型刻意松一点（unknown），避免上层每个调用点都 import SDK 类型。
 */
interface SDKUserMessageLike {
  type: 'user'
  message: {
    role: 'user'
    content: string | Array<TextBlockParam | ImageBlockParam | ToolResultBlockParam>
  }
  parent_tool_use_id: string | null
}

interface TextBlockParam {
  type: 'text'
  text: string
}

interface ImageBlockParam {
  type: 'image'
  source: ImageSource
}

interface ToolResultBlockParam {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface BuildPromptArgs {
  input: string | SessionInput
  storage?: StorageProvider
  envId: string
  sessionId: string
}

/**
 * 把用户输入翻译为 SDK prompt 的 AsyncIterable。
 *
 * 注意：本函数本身不是 async，但返回值是 AsyncIterable。
 * 内部 generator 在迭代时才执行 attachment 解析（保证流式语义）。
 */
export async function* buildPromptAsync(args: BuildPromptArgs): AsyncGenerator<SDKUserMessageLike, void, unknown> {
  const { input, storage, envId, sessionId } = args

  // 1. 归一化为 NormalizedInput（区分 message / tool_result）
  const normalized = normalizeInput(input)

  // 1.5 tool_result 回灌：构造单个 tool_result content block，直接产出
  if (normalized.kind === 'tool_result') {
    const tr = normalized.toolResult
    const contentText = typeof tr.output === 'string' ? tr.output : safeStringify(tr.output)
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tr.toolUseId,
            content: contentText,
            is_error: tr.isError ?? false,
          },
        ],
      },
      parent_tool_use_id: null,
    }
    return
  }

  // 2. 没有 attachments → 走纯文本快路径
  if (!normalized.attachments || normalized.attachments.length === 0) {
    yield {
      type: 'user',
      message: { role: 'user', content: normalized.text },
      parent_tool_use_id: null,
    }
    return
  }

  // 3. 有 attachments → 必须配 storage
  if (!storage) {
    throw new InvalidConfigError(
      'SessionInput contains attachments but AgentConfig.storage is not set. ' +
        'Provide an InMemoryStorage / CloudBaseStorage instance.',
    )
  }

  // 4. 逐个解析 attachment
  const resolved: ResolvedAttachment[] = []
  for (let i = 0; i < normalized.attachments.length; i++) {
    const att = normalized.attachments[i]
    const r = await storage.resolveAttachment(att, {
      envId,
      sessionId,
      index: i,
    })
    resolved.push(r)
  }

  // 5. 构造 SDKUserMessage（content blocks: image* + text）
  const blocks: Array<TextBlockParam | ImageBlockParam> = [
    ...resolved.map<ImageBlockParam>((r) => ({
      type: 'image',
      source: r.source,
    })),
    ...(normalized.text.length > 0 ? [{ type: 'text' as const, text: normalized.text }] : []),
  ]

  yield {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
  }
}

// ─── 辅助 ────────────────────────────────────────────────────────

type NormalizedInput =
  | { kind: 'message'; text: string; attachments?: AttachmentInput[] }
  | { kind: 'tool_result'; toolResult: Extract<SessionInput, { type: 'tool_result' }> }

// 兼容旧字段访问（text/attachments），message 分支直接展开
type _MessageNormalized = Extract<NormalizedInput, { kind: 'message' }>
interface _TextWrap extends _MessageNormalized {}

function normalizeInput(input: string | SessionInput): NormalizedInput {
  if (typeof input === 'string') {
    return { kind: 'message', text: input }
  }
  if (input.type === 'message') {
    return { kind: 'message', text: input.content, attachments: input.attachments }
  }
  if (input.type === 'tool_result') {
    return { kind: 'tool_result', toolResult: input }
  }
  // @ts-expect-error: exhaustiveness guard
  throw new InvalidConfigError(`SessionInput.type='${input.type}' is not supported in this version`)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
