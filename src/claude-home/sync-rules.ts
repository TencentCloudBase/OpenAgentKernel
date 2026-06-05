/**
 * 同步范围规则:白名单(用户私产 markdown)+ 黑名单(临时/缓存/平台资产)双层判断。
 *
 * 设计目标:不绑定特定 SDK 机制(auto-memory 在 SDK query() 模式下不工作 —
 * 见 v0.2.0 调试结论),改为"凡是 SDK 写出的用户级 markdown 配置都同步"。
 *
 * Spec A v3.2 同步范围(用户实测后收敛):
 *
 * ✅ 同步(白名单):
 *   - CLAUDE.md(根)— 用户级偏好
 *   - projects/* /memory/** /*.md — 主会话 auto-memory + dream 产物
 *   - agent-memory/** /*.md — 用户级 subagent memory
 *
 * ❌ 不同步(黑名单或不在白名单):
 *   - 平台资产:skills/ / rules/ / commands/ / agents/ / output-styles/ / themes/ /
 *               plugins/ — 业务方在镜像/cwd 管理,不跨用户同步
 *   - SDK 内部状态:.claude.json(OAuth/IDE/MCP 状态)/ .last-cleanup / backups/ /
 *               cache/ / shell-snapshots/ / statsig/ / telemetry/ / debug/ / downloads/
 *   - 进程级临时:ide/ / session-env/ / sessions/ / todos/
 *   - 配置文件:settings.json / settings.local.json / keybindings.json / history.jsonl
 *               (settings 故意不同步:OAK 启动时注入 autoMemoryEnabled 默认值,
 *                跨节点应每节点重新注入,不共享用户偏好覆盖)
 *   - Session transcript:projects/* /*.jsonl(已被 CloudBaseSessionStore 覆盖,
 *               避免重复同步)
 *
 * 项目级 subagent memory(<cwd>/.claude/agent-memory/)在 cwd 而非 CLAUDE_CONFIG_DIR,
 * 不在本规则范围(本规则只处理 CLAUDE_CONFIG_DIR 内的同步)。
 */

/**
 * SYNC_INCLUDES 用于文档/调试展示;实际匹配逻辑由 matchesSyncRule 函数实现。
 *
 * 模式描述(非 glob,仅供阅读):
 *   - 根目录的 CLAUDE.md
 *   - projects/<id>/memory/ 子树下的 .md
 *   - agent-memory/ 子树下的 .md
 */
export const SYNC_INCLUDES = ['CLAUDE.md', 'projects/*/memory/**/*.md', 'agent-memory/**/*.md'] as const

/**
 * 判断一个相对路径是否应该被同步。
 *
 * 规则按"先黑名单 reject,再白名单 accept"顺序判断。
 *
 * @param relPath 相对于 CLAUDE_CONFIG_DIR 的路径(用 / 分隔,无 leading /)。
 * @returns true 表示该文件在同步范围内
 */
export function matchesSyncRule(relPath: string): boolean {
  // ── 基本卫生检查 ────────────────────────────────
  if (!relPath) return false
  if (relPath.startsWith('/')) return false
  if (relPath.includes('..')) return false // 防御:本不该出现,但保险

  // ── 显式排除:.jsonl(session transcript)和 .json(settings 等)──
  // 不区分目录,所有 .jsonl / .json 都不同步
  if (relPath.endsWith('.jsonl')) return false
  if (relPath.endsWith('.json')) return false

  // ── 显式排除:平台资产目录(业务方/镜像管理,不跨用户同步)──
  if (isUnderTopDir(relPath, 'skills')) return false
  if (isUnderTopDir(relPath, 'rules')) return false
  if (isUnderTopDir(relPath, 'commands')) return false
  if (isUnderTopDir(relPath, 'agents')) return false
  if (isUnderTopDir(relPath, 'output-styles')) return false
  if (isUnderTopDir(relPath, 'themes')) return false
  if (isUnderTopDir(relPath, 'plugins')) return false

  // ── 显式排除:SDK 内部状态 / 临时缓存 ────────────
  if (isUnderTopDir(relPath, 'backups')) return false
  if (isUnderTopDir(relPath, 'cache')) return false
  if (isUnderTopDir(relPath, 'shell-snapshots')) return false
  if (isUnderTopDir(relPath, 'statsig')) return false
  if (isUnderTopDir(relPath, 'telemetry')) return false
  if (isUnderTopDir(relPath, 'debug')) return false
  if (isUnderTopDir(relPath, 'downloads')) return false
  if (isUnderTopDir(relPath, 'ide')) return false
  if (isUnderTopDir(relPath, 'session-env')) return false
  if (isUnderTopDir(relPath, 'sessions')) return false
  if (isUnderTopDir(relPath, 'todos')) return false

  // ── 排除单文件标记(SDK 内部维护,无 user value)──
  if (relPath === '.last-cleanup') return false
  if (relPath === 'history.jsonl') return false // 已被上面 .jsonl 黑名单覆盖,留作显式标记

  // ── 白名单 ──────────────────────────────────────
  // 1) CLAUDE.md(根)— 用户级偏好
  if (relPath === 'CLAUDE.md') return true

  // 2) projects/<id>/memory/** 下的 .md(主会话 auto-memory + dream)
  if (/^projects\/[^/]+\/memory\/.+\.md$/.test(relPath)) return true

  // 3) agent-memory/** 下的 .md(用户级 subagent memory)
  if (/^agent-memory\/.+\.md$/.test(relPath)) return true

  // 默认 reject:不在白名单 = 不同步
  return false
}

/**
 * 判断 relPath 是否在指定顶层目录下(包括目录本身)。
 *
 * 例子:
 *   isUnderTopDir('skills/foo/SKILL.md', 'skills')  → true
 *   isUnderTopDir('skills', 'skills')               → true(目录本身)
 *   isUnderTopDir('myskills/foo', 'skills')         → false(防止 prefix 误匹配)
 */
function isUnderTopDir(relPath: string, topDir: string): boolean {
  if (relPath === topDir) return true
  return relPath.startsWith(topDir + '/')
}
