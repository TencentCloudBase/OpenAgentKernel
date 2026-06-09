import { describe, it, expect } from 'vitest'
import {
  syncStatusSchema,
  healthResponseSchema,
  workspaceInitResponseSchema,
  snapshotSuccessSchema,
  RETRYABLE_ERROR_CODES,
} from '../types.js'

describe('syncStatusSchema', () => {
  it('parses minimal valid SyncStatus', () => {
    const s = syncStatusSchema.parse({
      restored: 'full',
      restoredAt: '2026-06-08T10:00:00Z',
      source: 'cos',
    })
    expect(s.restored).toBe('full')
  })

  it('accepts all 4 restored values and preserves them', () => {
    for (const r of ['full', 'partial', 'fresh', 'failed'] as const) {
      const s = syncStatusSchema.parse({ restored: r, restoredAt: 'x', source: 'cos' })
      expect(s.restored).toBe(r)
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

  it('tolerates unknown fields (forward compat)', () => {
    const r = healthResponseSchema.parse({
      ok: true,
      restoreStatus: null,
      bootProfile: { extra: 'whatever' },
      futureField: 123,
    })
    expect(r.ok).toBe(true)
    // .passthrough() 保留 unknown 字段(forward-compat 关键行为)
    expect((r as Record<string, unknown>).futureField).toBe(123)
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

  it('tolerates unknown fields in nested result (forward compat)', () => {
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
    // result 内层 .passthrough() 保留 unknown
    expect((r.result as Record<string, unknown>).futureField).toBe('whatever')
  })
})

describe('snapshotSuccessSchema', () => {
  it('parses { success: true, result: { ms } }', () => {
    const r = snapshotSuccessSchema.parse({ success: true, result: { ms: 1234 } })
    expect(r.result.ms).toBe(1234)
  })

  it('rejects { success: false }', () => {
    expect(() => snapshotSuccessSchema.parse({ success: false, result: { ms: 1 } })).toThrow()
  })

  it('rejects missing result.ms', () => {
    expect(() => snapshotSuccessSchema.parse({ success: true, result: {} })).toThrow()
  })
})

describe('RETRYABLE_ERROR_CODES', () => {
  it('contains workspace_snapshot_failed', () => {
    expect(RETRYABLE_ERROR_CODES.has('workspace_snapshot_failed')).toBe(true)
  })

  it('does not contain other random codes', () => {
    expect(RETRYABLE_ERROR_CODES.has('workspace_init_failed')).toBe(false)
  })
})
