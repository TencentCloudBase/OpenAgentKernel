/**
 * 同步范围白名单(allow-list,而非 black-list)。
 *
 * Spec A §3.4:仅同步 SDK 自动写入的"用户私产"。
 *   - CLAUDE.md(用户级偏好,SDK `/memory` 命令辅助维护)
 *   - projects/* /memory/**(主会话 auto-memory + dream 产物)
 *   - agent-memory/** /MEMORY.md(用户级 subagent memory)
 *
 * 不同步:settings.json / skills / commands / rules / agents / .claude.json /
 *        themes / keybindings.json / output-styles / projects/* /transcripts/。
 *
 * 项目级 subagent memory(<cwd>/.claude/agent-memory/)在另一处处理 — 仅当 cwd
 * 是 OAK 派生的受控目录时才同步,详见 §3.4 注释。本文件只处理 CLAUDE_CONFIG_DIR 内的同步。
 */

export const SYNC_INCLUDES = ['CLAUDE.md', 'projects/*/memory/**', 'agent-memory/**/MEMORY.md'] as const

/**
 * 判断一个相对路径是否应该被同步。
 *
 * @param relPath 相对于 CLAUDE_CONFIG_DIR 的路径(用 / 分隔,无 leading /)。
 * @returns true 表示该文件在同步范围内
 */
export function matchesSyncRule(relPath: string): boolean {
  if (!relPath) return false
  if (relPath.startsWith('/')) return false
  if (relPath.includes('..')) return false // 防御:本不该出现,但保险

  // CLAUDE.md(只在根)
  if (relPath === 'CLAUDE.md') return true

  // projects/<id>/memory/**
  const projectsMemoryRe = /^projects\/[^/]+\/memory\/.+/
  if (projectsMemoryRe.test(relPath)) return true

  // agent-memory/**/MEMORY.md
  const agentMemoryRe = /^agent-memory\/.+\/MEMORY\.md$/
  if (agentMemoryRe.test(relPath)) return true

  return false
}
