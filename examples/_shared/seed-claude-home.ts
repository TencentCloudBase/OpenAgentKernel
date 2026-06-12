/**
 * seed-claude-home.ts — 测试辅助:把内容预先写到 envId 对应的 CloudBase COS,
 * 模拟"用户之前已经累积了一些 .claude/ 配置"的状态。
 *
 * 用途:examples 16/17 验证 OAK 同步引擎能否在 SDK 启动 pull 时把这些预置内容
 *       带到本地,SDK 启动时把 CLAUDE.md 注入 prompt,模型据此回答。
 *
 * 通过 OAK 公开的 userMemory 文件管理 API 写入，避免示例依赖内部 COS store。
 */

import { deleteUserMemoryFiles, writeUserMemoryFiles, type PlatformCredentials } from '@cloudbase/open-agent-kernel'

export interface SeedFile {
  /** 相对 CLAUDE_CONFIG_DIR 的路径,例:'CLAUDE.md' / 'agent-memory/code-reviewer/MEMORY.md' */
  relPath: string
  /** 文件内容 */
  content: string
}

/**
 * 把多个文件写入 (envId, userId) 对应的 COS 命名空间。
 *
 * 失败会抛 — 调用方负责处理(测试里通常希望失败立刻可见)。
 */
export async function seedClaudeHome(args: {
  envId: string
  userId: string
  credentials: PlatformCredentials
  files: SeedFile[]
}): Promise<void> {
  await writeUserMemoryFiles({
    envId: args.envId,
    userId: args.userId,
    credentials: args.credentials,
    files: args.files.map((file) => ({ path: file.relPath, content: file.content })),
  })
}

/**
 * 清空 (envId, userId) 命名空间下我们 seed 过的文件。
 *
 * 不会列举 COS 自动发现 — 调用方传入需要清理的 relPath 列表(通常就是 seed 时用的那些)。
 */
export async function clearSeededClaudeHome(args: {
  envId: string
  userId: string
  credentials: PlatformCredentials
  relPaths: string[]
}): Promise<void> {
  await deleteUserMemoryFiles({
    envId: args.envId,
    userId: args.userId,
    credentials: args.credentials,
    paths: args.relPaths,
  })
}
