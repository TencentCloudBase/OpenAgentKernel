/**
 * 派生 per-user CLAUDE_CONFIG_DIR + sanitize 路径段。
 *
 * Spec A §4.2:必须以 os.tmpdir() 开头,envId/userId 走 sanitize 防止 ../ 注入。
 */

import * as os from 'node:os'
import * as path from 'node:path'

const ALLOWED_CHAR_RE = /^[a-zA-Z0-9._-]+$/
const REPLACE_FORBIDDEN_RE = /[^a-zA-Z0-9._-]/g

/**
 * 把单个路径段中不允许的字符替换为下划线。
 * 允许字符:[a-zA-Z0-9._-]。空字符串抛错(避免派生出空段)。
 *
 * 注意:`..` 在 sanitize 后仍是 `..`(因为 . 被允许)。这不会造成路径穿越,
 * 因为 deriveClaudeConfigDir 用 path.join 接 os.tmpdir(),最终路径仍在 tmpdir 内。
 */
export function sanitizePathSegment(s: string): string {
  if (s.length === 0) {
    throw new Error('sanitizePathSegment: input must be non-empty')
  }
  if (ALLOWED_CHAR_RE.test(s)) return s
  return s.replace(REPLACE_FORBIDDEN_RE, '_')
}

/**
 * 派生 per-user CLAUDE_CONFIG_DIR。
 *
 * 路径形如:`<os.tmpdir()>/oak/<safeEnvId>/<safeUserId>/.claude`
 *
 * 同 (envId, userId) 永远派生相同路径(供同进程多 session 共享同一目录,
 * SDK 也是这么设计的:per-user `~/.claude/` 全局目录)。
 */
export function deriveClaudeConfigDir(envId: string, userId: string): string {
  if (!envId) throw new Error('deriveClaudeConfigDir: envId is required')
  if (!userId) throw new Error('deriveClaudeConfigDir: userId is required')
  const safeEnv = sanitizePathSegment(envId)
  const safeUser = sanitizePathSegment(userId)
  return path.join(os.tmpdir(), 'oak', safeEnv, safeUser, '.claude')
}
