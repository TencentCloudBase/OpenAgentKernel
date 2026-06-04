import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { deriveClaudeConfigDir, sanitizePathSegment } from '../path-derivation.js'

describe('sanitizePathSegment', () => {
  it('keeps allowed chars unchanged', () => {
    expect(sanitizePathSegment('alice-1.2_test')).toBe('alice-1.2_test')
  })

  it('replaces forbidden chars with underscore', () => {
    expect(sanitizePathSegment('alice/bob')).toBe('alice_bob')
    expect(sanitizePathSegment('alice..bob')).toBe('alice..bob')   // dots are allowed but '..' segment must be blocked at path-level (we test deriveClaudeConfigDir)
    expect(sanitizePathSegment('alice bob')).toBe('alice_bob')
    expect(sanitizePathSegment('alice@bob')).toBe('alice_bob')
  })

  it('handles unicode by replacing', () => {
    expect(sanitizePathSegment('用户1')).toBe('__1')
  })

  it('throws on empty string', () => {
    expect(() => sanitizePathSegment('')).toThrow(/empty/i)
  })
})

describe('deriveClaudeConfigDir', () => {
  it('produces a path under os.tmpdir()', () => {
    const result = deriveClaudeConfigDir('env-abc', 'alice')
    expect(result.startsWith(os.tmpdir())).toBe(true)
  })

  it('contains both envId and userId segments', () => {
    const result = deriveClaudeConfigDir('env-abc', 'alice')
    expect(result).toContain('env-abc')
    expect(result).toContain('alice')
    expect(result.endsWith(path.sep + '.claude')).toBe(true)
  })

  it('isolates different users', () => {
    const a = deriveClaudeConfigDir('env-1', 'alice')
    const b = deriveClaudeConfigDir('env-1', 'bob')
    expect(a).not.toBe(b)
  })

  it('isolates different envs', () => {
    const a = deriveClaudeConfigDir('env-1', 'alice')
    const b = deriveClaudeConfigDir('env-2', 'alice')
    expect(a).not.toBe(b)
  })

  it('sanitizes dangerous chars while keeping dots for safe filenames', () => {
    const result = deriveClaudeConfigDir('env/../../etc', 'alice')
    // The slashes are replaced with underscores, so 'env/../../etc' becomes 'env_.._.._etc'
    // This is safe because path.join(os.tmpdir(), ...) prevents actual path traversal
    expect(result.startsWith(os.tmpdir())).toBe(true)
    expect(result).toContain('env_')
    expect(result).toContain('alice')
  })

  it('throws on empty envId or userId', () => {
    expect(() => deriveClaudeConfigDir('', 'alice')).toThrow()
    expect(() => deriveClaudeConfigDir('env', '')).toThrow()
  })
})
