/**
 * Sandbox tools：把 SandboxInstance 暴露为 Claude Agent SDK MCP server。
 *
 * 暴露的工具（注入到 SDK mcpServers 后名为 `mcp__sandbox__*`）：
 *   - bash    在沙箱里执行 shell 命令
 *   - read    读取沙箱里的文件
 *   - write   写入沙箱里的文件（覆盖）
 *   - edit    在文件中做精确字符串替换
 *   - glob    按 pattern 列文件
 *   - grep    跨文件搜索内容
 *
 * 实现策略（PR #6C 起）：
 *   所有工具直接调用 TRW 镜像内置的 `POST /api/tools/{name}` 端点，
 *   schema 与 opencode v1.14.33 builtin / Claude Code builtin 对齐。
 *   不再走 "bash + 拼字符串" 兜底实现，因为：
 *     - 单次 HTTP 完成（edit 之前要 2 次往返）
 *     - exact-once / 多段通配 / 编码 等语义由 TRW 服务端实现，更稳
 *     - 协议已被 OpenVibeCoding stateful-infra 生产验证
 *
 * 兼容性约定：
 *   TRW 端点返回 `{ success: boolean, result?: ..., error?: string }`，其中 result：
 *     - read   → `{ content: string }`
 *     - write  → `{ output: string }` 或 string
 *     - edit   → `{ output: string }` 或 string
 *     - bash   → `{ stdout, stderr, exitCode }`
 *     - glob   → string（行分隔的路径列表）
 *     - grep   → string（行分隔的 file:line:content）
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { SandboxError } from '../internal/errors.js'
import type { SandboxInstance } from './types.js'

const DEFAULT_BASH_TIMEOUT_MS = 60_000
const DEFAULT_API_TIMEOUT_MS = 30_000

interface ToolApiResponse<T = unknown> {
  success: boolean
  result?: T
  error?: string
}

/**
 * 调用沙箱 `/api/tools/{name}` 并解析标准应答。
 *
 * @throws SandboxError 当 HTTP 非 2xx、JSON 解析失败、或 `success === false` 时
 */
async function apiCall<T = unknown>(
  sandbox: SandboxInstance,
  toolName: string,
  body: unknown,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 5_000) // 给 TRW 多 5s 兜底
  let res: Response
  try {
    res = await sandbox.request(`/api/tools/${toolName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new SandboxError(`${toolName} HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  let data: ToolApiResponse<T>
  try {
    data = (await res.json()) as ToolApiResponse<T>
  } catch (err) {
    throw new SandboxError(`${toolName} response is not JSON`, err)
  }
  if (!data.success) {
    throw new SandboxError(`${toolName} failed: ${data.error ?? '<no error>'}`)
  }
  return data.result as T
}

/**
 * 把 TRW 返回的 result 归一化为字符串（兼容 `string` / `{output}` / `{content}` / 其他对象）。
 */
function resultToText(result: unknown, fallback = ''): string {
  if (result == null) return fallback
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (typeof r.output === 'string') return r.output
    if (typeof r.content === 'string') return r.content
    if (typeof r.text === 'string') return r.text
    return JSON.stringify(result)
  }
  return String(result)
}

/** 把异常包装成 MCP 工具的错误返回（不抛，交给 SDK 显示给模型）。 */
function toErrorResult(err: unknown): {
  content: [{ type: 'text'; text: string }]
  isError: true
} {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

/**
 * 创建 sandbox MCP server（注入给 Claude SDK 的 mcpServers）。
 *
 * @param sandbox SandboxInstance（来自 SandboxRuntime.acquire）
 */
export function createSandboxMcpServer(
  sandbox: SandboxInstance,
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'sandbox',
    version: '1.0.0',
    tools: [
      // ── bash ───────────────────────────────────────────────
      tool(
        'bash',
        'Execute a shell command inside the sandbox. ' +
          'Returns { stdout, stderr, exitCode }. The working directory is the sandbox workspace root.',
        {
          command: z.string().describe('The shell command to execute'),
          timeoutMs: z
            .number()
            .optional()
            .describe(`Timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS})`),
        },
        async (args) => {
          try {
            const timeoutMs = args.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS
            const result = await apiCall<Record<string, unknown>>(
              sandbox,
              'bash',
              { command: args.command, timeout: timeoutMs },
              timeoutMs,
            )
            const stdout = String(result.stdout ?? result.output ?? '')
            const stderr = String(result.stderr ?? '')
            const exitCode =
              typeof result.exitCode === 'number' ? result.exitCode : Number(result.exit_code ?? 0)
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `exitCode: ${exitCode}\n` +
                    (stdout ? `[stdout]\n${stdout}\n` : '') +
                    (stderr ? `[stderr]\n${stderr}` : ''),
                },
              ],
            }
          } catch (err) {
            return toErrorResult(err)
          }
        },
      ),

      // ── read ───────────────────────────────────────────────
      tool(
        'read',
        'Read the contents of a file in the sandbox. ' +
          'Returns the file content as text (each line prefixed with its 1-based line number). ' +
          'Optionally accepts `offset` (1-based line number) and `limit` (max lines) for paging large files.',
        {
          path: z.string().describe('Absolute or workspace-relative file path'),
          offset: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Line number to start reading from (1-based, must be >= 1)'),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Maximum number of lines to read'),
        },
        async (args) => {
          try {
            const result = await apiCall(sandbox, 'read', {
              path: args.path,
              offset: args.offset,
              limit: args.limit,
            })
            return { content: [{ type: 'text', text: resultToText(result) }] }
          } catch (err) {
            return toErrorResult(err)
          }
        },
      ),

      // ── write ──────────────────────────────────────────────
      tool(
        'write',
        'Write text content to a file in the sandbox (overwrites if exists; creates parent dirs).',
        {
          path: z.string().describe('Absolute or workspace-relative file path'),
          content: z.string().describe('Content to write (UTF-8 text)'),
        },
        async (args) => {
          try {
            const result = await apiCall(sandbox, 'write', {
              path: args.path,
              content: args.content,
            })
            const text =
              resultToText(result) ||
              `Wrote ${Buffer.byteLength(args.content, 'utf-8')} bytes to ${args.path}`
            return { content: [{ type: 'text', text }] }
          } catch (err) {
            return toErrorResult(err)
          }
        },
      ),

      // ── edit ───────────────────────────────────────────────
      tool(
        'edit',
        'Perform an exact string replacement in a file. ' +
          'By default `oldString` must appear exactly once (include surrounding context to disambiguate). ' +
          'Set `replaceAll: true` to replace every occurrence.',
        {
          path: z.string().describe('Absolute or workspace-relative file path'),
          oldString: z.string().describe('Exact text to replace'),
          newString: z.string().describe('Replacement text'),
          replaceAll: z
            .boolean()
            .optional()
            .describe('Replace all occurrences (default false)'),
        },
        async (args) => {
          try {
            const result = await apiCall(sandbox, 'edit', {
              path: args.path,
              oldString: args.oldString,
              newString: args.newString,
              replaceAll: args.replaceAll ?? false,
            })
            return {
              content: [{ type: 'text', text: resultToText(result, `Edited ${args.path}`) }],
            }
          } catch (err) {
            return toErrorResult(err)
          }
        },
      ),

      // ── glob ───────────────────────────────────────────────
      tool(
        'glob',
        'List files matching a glob pattern (supports "**/*.ts", "src/**/*.tsx", etc). ' +
          'Returns matching file paths, one per line.',
        {
          pattern: z
            .string()
            .describe('Glob pattern (e.g. "*.ts" or "**/package.json")'),
          path: z
            .string()
            .optional()
            .describe(
              'Directory to search in. Omit to use the sandbox working directory. ' +
                'IMPORTANT: do not pass "undefined" or "null" as a literal string.',
            ),
        },
        async (args) => {
          try {
            const result = await apiCall(sandbox, 'glob', {
              pattern: args.pattern,
              path: args.path,
            })
            const text = resultToText(result)
            return {
              content: [
                {
                  type: 'text',
                  text:
                    text.trim().length === 0
                      ? `No files matching "${args.pattern}"`
                      : text,
                },
              ],
            }
          } catch (err) {
            return toErrorResult(err)
          }
        },
      ),

      // ── grep ───────────────────────────────────────────────
      tool(
        'grep',
        'Search for a regex pattern across files in the sandbox. ' +
          'Returns matches as `file:line:content`. Use `glob` to restrict to certain file names (e.g. "*.ts").',
        {
          pattern: z.string().describe('Regex pattern to search for'),
          path: z
            .string()
            .optional()
            .describe('Directory or file to search in. Defaults to the working directory.'),
          glob: z
            .string()
            .optional()
            .describe('File-name glob filter (e.g. "*.ts", "*.{ts,tsx}")'),
        },
        async (args) => {
          try {
            const result = await apiCall(sandbox, 'grep', {
              pattern: args.pattern,
              path: args.path,
              glob: args.glob,
            })
            const text = resultToText(result)
            return {
              content: [
                {
                  type: 'text',
                  text:
                    text.trim().length === 0
                      ? `No matches for pattern "${args.pattern}"`
                      : text,
                },
              ],
            }
          } catch (err) {
            return toErrorResult(err)
          }
        },
      ),
    ],
  })
}
