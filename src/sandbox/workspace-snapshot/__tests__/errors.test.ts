import { describe, it, expect } from 'vitest'
import {
  WorkspaceSnapshotError,
  SandboxRestoreFailed,
  SandboxRestoreTimeout,
  SandboxUnavailableError,
} from '../errors.js'

describe('error classes', () => {
  it('WorkspaceSnapshotError carries retryable flag', () => {
    const e = new WorkspaceSnapshotError('boom', true)
    expect(e.retryable).toBe(true)
    expect(e.message).toBe('boom')
    expect(e.name).toBe('WorkspaceSnapshotError')
  })

  it('SandboxRestoreFailed carries note', () => {
    const e = new SandboxRestoreFailed('failed', { note: 'COS unreachable' })
    expect(e.note).toBe('COS unreachable')
    expect(e.name).toBe('SandboxRestoreFailed')
  })

  it('SandboxRestoreTimeout carries timeoutMs', () => {
    const e = new SandboxRestoreTimeout('timeout', 60_000)
    expect(e.timeoutMs).toBe(60_000)
  })

  it('SandboxUnavailableError carries httpStatus', () => {
    const e = new SandboxUnavailableError('502', 502)
    expect(e.httpStatus).toBe(502)
  })
})
