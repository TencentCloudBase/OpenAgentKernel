import { describe, it, expect } from 'vitest'
import { syncStatusSchema, healthResponseSchema, workspaceInitResponseSchema } from '../types.js'

describe('syncStatusSchema', () => {
  it('parses minimal valid SyncStatus', () => {
    const s = syncStatusSchema.parse({
      restored: 'full',
      restoredAt: '2026-06-08T10:00:00Z',
      source: 'cos',
    })
    expect(s.restored).toBe('full')
  })

  it('accepts all 4 restored values', () => {
    for (const r of ['full', 'partial', 'fresh', 'failed']) {
      expect(() => syncStatusSchema.parse({ restored: r, restoredAt: 'x', source: 'cos' })).not.toThrow()
    }
  })

  it('rejects unknown restored value', () => {
    expect(() => syncStatusSchema.parse({ restored: 'unknown', restoredAt: 'x', source: 'cos' })).toThrow()
  })

  it('accepts optional fields (restoreMs, cosMetaSizeBytes, steps, note)', () => {
    const s = syncStatusSchema.parse({
      restored: 'full',
      restoredAt: '2026-06-08T10:00:00Z',
      source: 'cos',
      restoreMs: 1234,
      cosMetaSizeBytes: 4096,
      cosMetaFileCount: 12,
      steps: { restoreFromCosMs: 800, ensureSkelFilesMs: 12 },
      note: 'restored from snapshot abc',
    })
    expect(s.restoreMs).toBe(1234)
    expect(s.steps?.restoreFromCosMs).toBe(800)
  })
})

describe('healthResponseSchema', () => {
  it('parses health body with restoreStatus null (still booting)', () => {
    const r = healthResponseSchema.parse({ ok: true, restoreStatus: null })
    expect(r.restoreStatus).toBeNull()
  })

  it('parses health body with full SyncStatus', () => {
    const r = healthResponseSchema.parse({
      ok: true,
      restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
    })
    expect(r.restoreStatus?.restored).toBe('full')
  })

  it('extra fields are stripped (forward compat)', () => {
    const r = healthResponseSchema.parse({
      ok: true,
      restoreStatus: null,
      bootProfile: { extra: 'whatever' },
      futureField: 123,
    })
    expect(r.ok).toBe(true)
  })
})

describe('workspaceInitResponseSchema', () => {
  it('parses real init response (no restoreStatus, only workspace + git + env)', () => {
    const r = workspaceInitResponseSchema.parse({
      success: true,
      result: {
        workspace: '/home/user',
        git: { enabled: true, hasGit: true, branch: 'main' },
        env: { TCB_ENV_ID: '<set>' },
      },
    })
    expect(r.result.workspace).toBe('/home/user')
  })

  it('accepts optional set/ignored/skillsMaterialized fields', () => {
    const r = workspaceInitResponseSchema.parse({
      success: true,
      result: {
        workspace: '/home/user',
        git: { enabled: false, hasGit: false },
        env: {},
        set: ['TCB_ENV_ID'],
        ignored: ['UNSAFE_KEY'],
        skillsMaterialized: 3,
      },
    })
    expect(r.result.set).toEqual(['TCB_ENV_ID'])
  })

  it('extra fields are stripped (forward compat)', () => {
    const r = workspaceInitResponseSchema.parse({
      success: true,
      result: {
        workspace: '/home/user',
        git: { enabled: true, hasGit: true },
        env: {},
        envSet: ['x'],
        futureField: 'whatever',
      },
    })
    expect(r.success).toBe(true)
  })
})
