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
  process.env.CLOUDBASE_APIKEY = 'test-key'
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('buildClaudeQueryOptions — cwd / settingSources', () => {
  it('no cwd → falls back to process.cwd() + settingSources=[]', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    // kernel 不再自造 ephemeral 目录;没传 cwd 时诚实兜底 process.cwd()
    expect(options.cwd).toBe(process.cwd())
    expect(options.settingSources).toEqual([])
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
  it('skills.enabled set → tools includes AskUserQuestion and Skill', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: 'all' } })
    expect(options.tools).toEqual(['AskUserQuestion', 'Skill'])
  })

  it('skills.enabled = string[] → tools includes AskUserQuestion and Skill', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, skills: { enabled: ['greet'] } })
    expect(options.tools).toEqual(['AskUserQuestion', 'Skill'])
  })

  it('no skills config → tools is AskUserQuestion only', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.tools).toEqual(['AskUserQuestion'])
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
    // per-user 路径:<workRoot>/.oak/users/<env>/<user>/.claude
    expect(options.env?.CLAUDE_CONFIG_DIR).toContain('alice')
    expect(options.env?.CLAUDE_CONFIG_DIR).toContain(path.join('.oak', 'users'))
    expect(options.env?.CLAUDE_CONFIG_DIR?.endsWith('.claude')).toBe(true)
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

  // 设计决策:effectiveCwd 不再随 userMemory 派生 per-user 路径,统一 userCwd ?? process.cwd()
  // (CLAUDE_CONFIG_DIR 仍 per-user 派生;cwd 与配置目录解耦)。
  it('userMemory.enabled + userId without cwd → effectiveCwd is process.cwd()', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, userMemory: { enabled: true } }, { userId: 'alice' })
    expect(options.cwd).toBe(process.cwd())
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

  // 注:CLAUDE_CONFIG_DIR 现在无条件设置(per-user 派生 或 .oak/agent/.claude 全局兜底),
  // 避免回落到只读宿主 ~/.claude。未启用 per-user 时退到 agent 全局目录。
  const AGENT_FALLBACK = path.join('.oak', 'agent', '.claude')

  it('userMemory.enabled but no userId → no syncEngine, CLAUDE_CONFIG_DIR = agent fallback', () => {
    const { options, syncEngine } = buildClaudeQueryOptions(
      { ...baseConfig, userMemory: { enabled: true } },
      {}, // no userId
    )
    expect(syncEngine).toBeUndefined()
    expect(options.env?.CLAUDE_CONFIG_DIR).toContain(AGENT_FALLBACK)
    expect(options.env?.CLAUDE_CONFIG_DIR).not.toContain('alice')
  })

  it('userMemory disabled → no syncEngine, CLAUDE_CONFIG_DIR = agent fallback', () => {
    const { options, syncEngine } = buildClaudeQueryOptions(
      { ...baseConfig, userMemory: { enabled: false } },
      { userId: 'alice' },
    )
    expect(syncEngine).toBeUndefined()
    expect(options.env?.CLAUDE_CONFIG_DIR).toContain(AGENT_FALLBACK)
  })

  it('userMemory + no credentials but CLOUDBASE_APIKEY env → syncEngine active (env fallback)', () => {
    // COS 凭证缺失但 process.env.CLOUDBASE_APIKEY 存在 → cos-store resolveCredentials
    // 走 env fallback 路径,syncEngine 正常创建
    const { syncEngine } = buildClaudeQueryOptions(
      { ...baseConfig, credentials: undefined, userMemory: { enabled: true } },
      { userId: 'alice' },
    )
    expect(syncEngine).toBeDefined()
  })

  it('userMemory + no credentials and no CLOUDBASE_APIKEY env → graceful degrade', () => {
    // 完全无凭证时构造 store 抛 InvalidConfigError → agent-builder try/catch 兜住,
    // syncEngine=undefined,不影响 send 主流程。
    // 用显式 model.apiKey 避免模型网关 resolveApiKey 也依赖 CLOUDBASE_APIKEY
    const savedKey = process.env.CLOUDBASE_APIKEY
    delete process.env.CLOUDBASE_APIKEY
    try {
      expect(() => {
        const { options, syncEngine } = buildClaudeQueryOptions(
          {
            ...baseConfig,
            credentials: undefined,
            model: { id: 'glm-5.1', apiKey: 'explicit-model-key' },
            userMemory: { enabled: true },
          },
          { userId: 'alice' },
        )
        expect(syncEngine).toBeUndefined()
        expect(options.env?.CLAUDE_CONFIG_DIR).toContain(AGENT_FALLBACK)
      }).not.toThrow()
    } finally {
      process.env.CLOUDBASE_APIKEY = savedKey
    }
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

// ─────────────────────────────────────────────────────────────────
// cwdPersistEngine(仅 sandboxMode='local' 时启用)
// ─────────────────────────────────────────────────────────────────

describe('buildClaudeQueryOptions — cwdPersistEngine', () => {
  const cwd = os.tmpdir() // writable

  it("sandboxMode='local' + writable cwd + sessionId → returns cwdPersistEngine", () => {
    const { cwdPersistEngine } = buildClaudeQueryOptions(
      { ...baseConfig, cwd },
      { sessionId: 'sess-1', userId: 'alice', sandboxMode: 'local' },
    )
    expect(cwdPersistEngine).toBeDefined()
  })

  it("sandboxMode='none' → undefined (no builtin tools, cwd不会被改)", () => {
    const { cwdPersistEngine } = buildClaudeQueryOptions(
      { ...baseConfig, cwd },
      { sessionId: 'sess-1', sandboxMode: 'none' },
    )
    expect(cwdPersistEngine).toBeUndefined()
  })

  it("sandboxMode='remote' → undefined (AGS snapshot 负责)", () => {
    const agsRuntime: SandboxRuntime = {
      backend: 'ags-stateful',
      acquire: vi.fn(),
    } as unknown as SandboxRuntime
    const { cwdPersistEngine } = buildClaudeQueryOptions(
      {
        ...baseConfig,
        cwd,
        sandbox: { enabled: true, scope: 'shared', runtime: agsRuntime },
      },
      { sessionId: 'sess-1', sandboxMode: 'remote' },
    )
    expect(cwdPersistEngine).toBeUndefined()
  })

  it("sandboxMode='local' + missing sessionId → undefined (warn + skip)", () => {
    const { cwdPersistEngine } = buildClaudeQueryOptions(
      { ...baseConfig, cwd },
      { userId: 'alice', sandboxMode: 'local' },
    )
    expect(cwdPersistEngine).toBeUndefined()
  })

  it("sandboxMode='local' + no credentials but CLOUDBASE_APIKEY env → cwdPersistEngine active (env fallback)", () => {
    const { cwdPersistEngine } = buildClaudeQueryOptions(
      { ...baseConfig, credentials: undefined, cwd },
      { sessionId: 'sess-1', sandboxMode: 'local' },
    )
    expect(cwdPersistEngine).toBeDefined()
  })

  it("sandboxMode='local' + no credentials and no CLOUDBASE_APIKEY env → graceful degrade", () => {
    const savedKey = process.env.CLOUDBASE_APIKEY
    delete process.env.CLOUDBASE_APIKEY
    try {
      expect(() => {
        const { cwdPersistEngine } = buildClaudeQueryOptions(
          {
            ...baseConfig,
            credentials: undefined,
            model: { id: 'glm-5.1', apiKey: 'explicit-model-key' },
            cwd,
          },
          { sessionId: 'sess-1', sandboxMode: 'local' },
        )
        expect(cwdPersistEngine).toBeUndefined()
      }).not.toThrow()
    } finally {
      process.env.CLOUDBASE_APIKEY = savedKey
    }
  })
})

// ─────────────────────────────────────────────────────────────────
// streaming（includePartialMessages）
// ─────────────────────────────────────────────────────────────────

describe('buildClaudeQueryOptions — streaming', () => {
  // AcpStreamAdapter always handles streaming; includePartialMessages is
  // always true so the adapter receives stream_event deltas.
  it('includePartialMessages is always true', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.includePartialMessages).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────
// builtin tools（内置工具开关,由 sandboxMode 驱动）
// ─────────────────────────────────────────────────────────────────

describe('buildClaudeQueryOptions — builtin tools', () => {
  it('default (no sandbox) → tools = ["AskUserQuestion"]', () => {
    const { options } = buildClaudeQueryOptions(baseConfig)
    expect(options.tools).toEqual(['AskUserQuestion'])
  })

  it('skills enabled, no sandbox → tools = ["AskUserQuestion", "Skill"]', () => {
    const { options } = buildClaudeQueryOptions({ ...baseConfig, cwd: os.tmpdir(), skills: { enabled: 'all' } })
    expect(options.tools).toEqual(['AskUserQuestion', 'Skill'])
  })

  it("sandboxMode='remote' → tools = ['AskUserQuestion'] (no FS builtins)", () => {
    const { options } = buildClaudeQueryOptions(baseConfig, { sandboxMode: 'remote' })
    expect(options.tools).toEqual(['AskUserQuestion'])
  })

  it("sandboxMode='local' → claude_code preset (provider auto-enables builtins)", () => {
    const { options } = buildClaudeQueryOptions(baseConfig, { sandboxMode: 'local' })
    expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  it("sandboxMode='local' + skills → claude_code preset (preset 已含 Skill)", () => {
    const { options } = buildClaudeQueryOptions(
      { ...baseConfig, cwd: os.tmpdir(), skills: { enabled: 'all' } },
      { sandboxMode: 'local' },
    )
    expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  it('clientToolStore present → does not inject mcpServers.kernel', () => {
    const clientToolStore = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
    }
    const { options } = buildClaudeQueryOptions(baseConfig, {
      clientToolStore,
      conversationId: 'c1',
      hookLocalState: { hasInterruptedThisRun: false },
    })
    expect(options.mcpServers?.kernel).toBeUndefined()
    expect(options.tools).toEqual(['AskUserQuestion'])
  })
})
