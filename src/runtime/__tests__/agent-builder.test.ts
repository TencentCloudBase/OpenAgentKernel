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

import { describe, it, expect, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { buildClaudeQueryOptions } from '../agent-builder.js'
import type { AgentConfig } from '../../public/types.js'

const baseConfig: AgentConfig = {
  envId: 'env-test',
  model: 'glm-5.1',
}

// 跑前给 credential factory 一个非空 API key,避免 resolveCredential 抛错。
// 同时清除 host 可能存在的 CLAUDE_CONFIG_DIR(开发机会设),否则 ...process.env
// 会让"未启用 userMemory"的断言看到非 undefined 值。
beforeEach(() => {
  process.env.TENCENTCLOUD_TOKENHUB_API_KEY = 'test-key'
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
    expect(() =>
      buildClaudeQueryOptions({ ...baseConfig, cwd: path.join(os.homedir(), '.claude') }),
    ).toThrow(/cannot point at host/)
  })

  it('user cwd = ~/.claude/sub → throws InvalidConfigError', () => {
    expect(() =>
      buildClaudeQueryOptions({ ...baseConfig, cwd: path.join(os.homedir(), '.claude/sub') }),
    ).toThrow(/cannot point at host/)
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
})

describe('buildClaudeQueryOptions — userMemory', () => {
  // CloudBaseCosClaudeHomeStore 构造时 resolveCredentials 会读 env,
  // 测试时设 process.env.TCB_ENV_ID/SECRET_ID/SECRET_KEY 让构造不抛
  beforeEach(() => {
    process.env.TCB_ENV_ID = 'env-test'
    process.env.TCB_SECRET_ID = 'test-id'
    process.env.TCB_SECRET_KEY = 'test-key'
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
})
