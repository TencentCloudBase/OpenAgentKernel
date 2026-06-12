import { Buffer } from 'node:buffer'
import { CloudBaseCosClaudeHomeStore } from '../claude-home/index.js'
import type { PlatformCredentials } from '../public/types.js'

export interface UserMemoryFile {
  /**
   * 相对用户 .claude 目录的路径。
   *
   * 常见值：
   * - `CLAUDE.md`：用户级偏好
   * - `agent-memory/<agent-name>/MEMORY.md`：用户级 subagent memory
   */
  path: string
  /** 文件内容，字符串按 UTF-8 写入 */
  content: string | Buffer
}

export interface UserMemoryFilesOptions {
  envId: string
  userId: string
  credentials: PlatformCredentials
}

export interface WriteUserMemoryFilesOptions extends UserMemoryFilesOptions {
  files: UserMemoryFile[]
}

export interface DeleteUserMemoryFilesOptions extends UserMemoryFilesOptions {
  paths: string[]
}

/**
 * 写入用户级长期记忆文件。
 *
 * 这是 `userMemory: true` 的配套管理 API，用于预置或更新
 * CloudBase COS 中的用户 `.claude/` 文件。普通对话同步仍由 `createAgent`
 * 在 `session.send()` 生命周期内自动处理。
 */
export async function writeUserMemoryFiles(opts: WriteUserMemoryFilesOptions): Promise<void> {
  const store = new CloudBaseCosClaudeHomeStore({
    credentials: { ...opts.credentials, envId: opts.credentials.envId ?? opts.envId },
  })
  for (const file of opts.files) {
    const content = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content
    await store.put({ envId: opts.envId, userId: opts.userId }, file.path, content)
  }
}

/**
 * 删除用户级长期记忆文件。
 *
 * 删除不存在的文件会按底层 CloudBase COS store 的语义静默成功。
 */
export async function deleteUserMemoryFiles(opts: DeleteUserMemoryFilesOptions): Promise<void> {
  const store = new CloudBaseCosClaudeHomeStore({
    credentials: { ...opts.credentials, envId: opts.credentials.envId ?? opts.envId },
  })
  for (const path of opts.paths) {
    await store.delete({ envId: opts.envId, userId: opts.userId }, path)
  }
}
