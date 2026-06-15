/**
 * agent-builder.test.ts
 *
 * 单元测试 buildClaudeQueryOptions 的关键派生逻辑:
 *   - cwd / settingSources(spec §4.1)
 *   - skills 透传
 *   - userMemory(spec §4.2 + §4.6) → CLAUDE_CONFIG_DIR + syncEngine
 *   - C1 修复:ephemeral cwd 必须 mkdir
 *   - I2 修复:assertSafeUserCwd 走 realpathSync
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { buildClaudeQueryOptions } from '../agent-builder.js'
import type { AgentConfig } from '../../public/types.js'
import type { SandboxRuntime } from '../../sandbox/types.js'

const baseConfig: AgentConfig = {
  envId: 'env-test',
  model: 'glm-5.1',
  credentials: { envId: 'env-test', secretId: 'test-id', secretKey: 'test-key' },
}

// 跑前给 credential factory 一个非空 API key,避免 resolveCredential 抛错。
// 同时清除 host 可能存在的 CLAUDE_CONFIG_DIR(开发机会设),否则 ...process.env
// 会让"未启用 userMemory"的断言看到非 undefined 值。
beforeEach(() => {
  process.env.TCB_API_KEY = 'test-key'
  delete process.env.CLOUDBASE_API_KEY
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('buildClaudeQueryOptions — cwd / settingSources', () => {
  it('no cwd → ephemeral cwd + settingSources=[]', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.cwd).toMatch(/oak-ephemeral-/)
    expect(options.cwd?.startsWith(os.tmpdir())).toBe(true)
    expect(options.settingSources).toEqual([])
    // C1 fix verification:ephemeral dir 实际被创建
    expect(existsSync(options.cwd!)).toBe(true)
  })

  it('user cwd → settingSources=["project"]', () => {
    const cwd = os.tmpdir() // 安全的 tmpdir
    const { options } = buildClaudeQueryOptions({ ...baseConfig, cwd })
    expect(options.cwd).toBe(cwd)
    expect(options.settingSources).toEqual(['project'])
  })

  it('user cwd = ~/.claude → throws InvalidConfigError', () => {
    expect(() => buildClaudeQueryOptions({ ...baseConfig, cwd: path.join(os.homedir(), '.claude') })).toThrow(
      /cannot point at host/,
    )
  })

  it('user cwd = ~/.claude/sub → throws InvalidConfigError', () => {
    expect(() => buildClaudeQueryOptions({ ...baseConfig, cwd: path.join(os.homedir(), '.claude/sub') })).toThrow(
      /cannot point at host/,
    )
  })
})

describe('buildClaudeQueryOptions — skills', () => {
  it('skills.enabled = "all" → forwarded', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: 'all' } })
    expect(options.skills).toBe('all')
  })

  it('skills.enabled = ["foo"] → forwarded', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: ['foo'] } })
    expect(options.skills).toEqual(['foo'])
  })

  it('skills.enabled = [] → forwarded(empty array)', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: [] } })
    expect(options.skills).toEqual([])
  })

  it('no skills config → options.skills undefined', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.skills).toBeUndefined()
  })

  // 关键 bug 修复:启用 skills 时,'Skill' 工具必须在 options.tools 中,
  // 否则 SDK 加载了 skill 元数据但模型无工具可 invoke(用户实测发现的 bug)
  // SDK 文档:"If you also pass an explicit tools list, include 'Skill' in that list
  //          so Claude can invoke skills."
  it('skills.enabled set → tools includes "Skill"', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: 'all' } })
    expect(options.tools).toEqual(['Skill'])
  })

  it('skills.enabled = string[] → tools includes "Skill"', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: ['greet'] } })
    expect(options.tools).toEqual(['Skill'])
  })

  it('no skills config → tools is empty (existing behavior)', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.tools).toEqual([])
  })

  it('skills configured but cwd missing → emits warning', () => {
    // 此场景 SDK settingSources=[] 不会发现 SKILL.md → skills 静默失效
    // OAK 显式 warning 提醒业务方
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: 'all' } })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/skills configured but cwd not set/))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('skills configured AND cwd set → no warning (skills will be discovered)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      buildClaudeQueryOptions({ ...baseConfig, cwd: os.tmpdir(), skills: { enabled: 'all' } })
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/skills configured but cwd not set/))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('buildClaudeQueryOptions — userMemory', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('userMemory.enabled + userId → returns syncEngine + CLAUDE_CONFIG_DIR per-user', () => {
    const { options, syncEngine } = buildClaudeQueryOptions(
      { ...baseConfig, userMemory: { enabled: true } },
      { userId: 'alice' },
    )
    expect(syncEngine).toBeDefined()
    expect(options.env?.CLAUDE_CONFIG_DIR).toContain('alice')
    expect(options.env?.CLAUDE_CONFIG_DIR?.startsWith(os.tmpdir())).toBe(true)
  })

  // 关键修复:userMemory 启用时,settingSources 必须含 'user',
  // 否则 SDK auto-memory 不会读写文件 → 同步引擎扫描永远空,记忆不持久化
  it('userMemory.enabled + userId → settingSources includes "user"', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, userMemory: { enabled: true } }, { userId: 'alice' })
    expect(options.settingSources).toContain('user')
  })

  it('userMemory shorthand true + userId → settingSources includes "user"', () => {
    const { options, syncEngine } = buildClaudeQueryOptions({ ...baseConfig, userMemory: true }, { userId: 'alice' })
    expect(syncEngine).toBeDefined()
    expect(options.settingSources).toContain('user')
  })

  // userMemory 启用且无 cwd → effectiveCwd 应该用 per-user 稳定路径
  // (而非 ephemeral 随机),让 SDK projects/<cwd-hash>/ 跨节点稳定
  it('userMemory.enabled + userId without cwd → effectiveCwd is stable per-user (not ephemeral)', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, userMemory: { enabled: true } }, { userId: 'alice' })
    expect(options.cwd).not.toMatch(/oak-ephemeral-/)
    expect(options.cwd).toContain('alice')
    // cwd 应是 claudeConfigDir 的上一级(去掉末尾 .claude)
    expect(options.cwd?.endsWith('/.claude')).toBe(false)
    // 跨调用应稳定(同 envId+userId 永远一致)
    const second = buildClaudeQueryOptions({ ...baseConfig, userMemory: { enabled: true } }, { userId: 'alice' })
    expect(second.options.cwd).toBe(options.cwd)
  })

  it('userMemory.enabled + cwd both → cwd wins for effectiveCwd, settingSources has both', () => {
    const cwd = os.tmpdir()
    const { options } = buildClaudeQueryOptions(
      { ...baseConfig, cwd, userMemory: { enabled: true } },
      { userId: 'alice' },
    )
    expect(options.cwd).toBe(cwd)
    expect(options.settingSources).toContain('project')
    expect(options.settingSources).toContain('user')
  })

  // 关键修复:userMemory.enabled 时,SDK persistSession 必须是 true,
  // 否则 SDK 不创建 ~/.claude/projects/<cwd-hash>/ 目录 → auto-memory 无处写 MEMORY.md
  // SDK 文档:"persistSession=false → Sessions will not be saved to ~/.claude/projects/"
  it('userMemory.enabled + userId → persistSession is true', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, userMemory: { enabled: true } }, { userId: 'alice' })
    expect(options.persistSession).toBe(true)
  })

  it('no userMemory + no sessionStore → persistSession is false (legacy)', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.persistSession).toBe(false)
  })

  // 关键修复:userMemory.enabled 时,SDK persistSession 必须是 true,
  // 否则 SDK 不创建 ~/.claude/projects/<cwd-hash>/ 目录 → auto-memory 无处写 MEMORY.md
  // SDK 文档:"persistSession=false → Sessions will not be saved to ~/.claude/projects/"
  it('userMemory.enabled + userId → persistSession is true', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, userMemory: { enabled: true } }, { userId: 'alice' })
    expect(options.persistSession).toBe(true)
  })

  it('no userMemory + no sessionStore → persistSession is false (legacy)', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.persistSession).toBe(false)
  })

  it('userMemory.enabled but no userId → no syncEngine, no CLAUDE_CONFIG_DIR', () => {
    const { options, syncEngine } = buildClaudeQueryOptions(
      { ...baseConfig, userMemory: { enabled: true } },
      {}, // no userId
    )
    expect(syncEngine).toBeUndefined()
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('userMemory disabled → no syncEngine even with userId', () => {
    const { options, syncEngine } = buildClaudeQueryOptions(
      { ...baseConfig, userMemory: { enabled: false } },
      { userId: 'alice' },
    )
    expect(syncEngine).toBeUndefined()
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('userMemory + missing credentials → graceful degrade (no syncEngine, no throw)', () => {
    // 模拟 spec §3.1:COS 凭证缺失时,构造 store 抛 InvalidConfigError →
    // agent-builder 应 try/catch 兜住,返回 syncEngine=undefined,不影响 send 主流程
    expect(() => {
      const { options, syncEngine } = buildClaudeQueryOptions(
        { ...baseConfig, credentials: undefined, userMemory: { enabled: true } },
        { userId: 'alice' },
      )
      expect(syncEngine).toBeUndefined()
      // CLAUDE_CONFIG_DIR 也跟着清空(graceful degrade 全套不留半截状态)
      expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    }).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────
// Spec B(workspace snapshot)
// ─────────────────────────────────────────────────────────────────

describe('buildClaudeQueryOptions — workspaceSnapshot', () => {
  const goodRuntime: SandboxRuntime = {
    backend: 'ags-stateful',
    acquire: vi.fn(),
  }
  const otherRuntime: SandboxRuntime = {
    backend: 'docker-local',
    acquire: vi.fn(),
  }

  it('returns snapshotEngine when sandbox.runtime is ags-stateful and scope=shared (auto)', () => {
    const result = buildClaudeQueryOptions({
      ...baseConfig,
      sandbox: { runtime: goodRuntime, scope: 'shared', workspaceSnapshot: 'auto' },
    })
    expect(result.snapshotEngine).toBeDefined()
  })

  it('returns no snapshotEngine when workspaceSnapshot=disabled', () => {
    const result = buildClaudeQueryOptions({
      ...baseConfig,
      sandbox: { runtime: goodRuntime, scope: 'shared', workspaceSnapshot: 'disabled' },
    })
    expect(result.snapshotEngine).toBeUndefined()
  })

  it('returns no snapshotEngine when runtime backend != ags-stateful and mode=auto', () => {
    const result = buildClaudeQueryOptions({
      ...baseConfig,
      sandbox: { runtime: otherRuntime, scope: 'shared', workspaceSnapshot: 'auto' },
    })
    expect(result.snapshotEngine).toBeUndefined()
  })

  it('throws ConfigError when mode=enabled but runtime backend not supported', () => {
    expect(() =>
      buildClaudeQueryOptions({
        ...baseConfig,
        sandbox: { runtime: otherRuntime, scope: 'shared', workspaceSnapshot: 'enabled' },
      }),
    ).toThrow(/does not support snapshot/)
  })

  it('throws ConfigError when snapshot enabled but scope=session', () => {
    expect(() =>
      buildClaudeQueryOptions({
        ...baseConfig,
        sandbox: { runtime: goodRuntime, scope: 'session', workspaceSnapshot: 'auto' },
      }),
    ).toThrow(/scope='shared'/)
  })

  it('throws ConfigError when snapshot enabled but scope undefined (defaults to session)', () => {
    expect(() =>
      buildClaudeQueryOptions({
        ...baseConfig,
        sandbox: { runtime: goodRuntime, workspaceSnapshot: 'auto' },
      }),
    ).toThrow(/scope='shared'/)
  })

  it('passes timeouts to engine constructor (does not throw)', () => {
    const result = buildClaudeQueryOptions({
      ...baseConfig,
      sandbox: {
        runtime: goodRuntime,
        scope: 'shared',
        workspaceSnapshot: 'enabled',
        workspaceSnapshotTimeoutMs: 5_000,
        workspaceInitTimeoutMs: 10_000,
      },
    })
    expect(result.snapshotEngine).toBeDefined()
  })
})
