import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  deriveAgentConfigDir,
  deriveClaudeConfigDir,
  deriveSyncTmpDir,
  getOakRoot,
  OAK_ROOT_SEGMENT,
  sanitizePathSegment,
} from '../path-derivation.js'

describe('sanitizePathSegment', () => {
  it('keeps allowed chars unchanged', () => {
    expect(sanitizePathSegment('alice-1.2_test')).toBe('alice-1.2_test')
  })

  it('replaces forbidden chars with underscore', () => {
    expect(sanitizePathSegment('alice/bob')).toBe('alice_bob')
    expect(sanitizePathSegment('alice..bob')).toBe('alice..bob') // dots are allowed but '..' segment must be blocked at path-level (we test deriveClaudeConfigDir)
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
  it('produces a path under the resolved .oak root', () => {
    const result = deriveClaudeConfigDir('env-abc', 'alice')
    expect(result.startsWith(getOakRoot())).toBe(true)
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
    // This is safe because path.join(workRoot, ...) prevents actual path traversal
    expect(result.startsWith(getOakRoot())).toBe(true)
    expect(result).toContain('env_')
    expect(result).toContain('alice')
  })

  it('throws on empty envId or userId', () => {
    expect(() => deriveClaudeConfigDir('', 'alice')).toThrow()
    expect(() => deriveClaudeConfigDir('env', '')).toThrow()
  })

  it('lives under the unified .oak/users subtree', () => {
    const result = deriveClaudeConfigDir('env-1', 'alice')
    expect(result).toContain(path.join(OAK_ROOT_SEGMENT, 'users'))
    expect(result.startsWith(getOakRoot())).toBe(true)
  })
})

describe('.oak layout', () => {
  it('getOakRoot is <workRoot>/.oak where workRoot is writable home or tmpdir', () => {
    const root = getOakRoot()
    expect(path.basename(root)).toBe(OAK_ROOT_SEGMENT)
    // default workRoot is either os.homedir() (when writable) or os.tmpdir()
    const parent = path.dirname(root)
    expect([os.homedir(), os.tmpdir()]).toContain(parent)
  })

  it('deriveAgentConfigDir is .oak/agent/.claude', () => {
    const result = deriveAgentConfigDir()
    expect(result).toBe(path.join(getOakRoot(), 'agent', '.claude'))
  })

  it('deriveSyncTmpDir is .oak/sync', () => {
    expect(deriveSyncTmpDir()).toBe(path.join(getOakRoot(), 'sync'))
  })

  it('all subtrees share the .oak root (for per-subtree permission assignment)', () => {
    const root = getOakRoot()
    expect(deriveAgentConfigDir().startsWith(root)).toBe(true)
    expect(deriveClaudeConfigDir('e', 'u').startsWith(root)).toBe(true)
    expect(deriveSyncTmpDir().startsWith(root)).toBe(true)
  })

  it('respects OAK_SESSION_LOCAL_DIR as workRoot override', () => {
    const prev = process.env.OAK_SESSION_LOCAL_DIR
    process.env.OAK_SESSION_LOCAL_DIR = '/custom/work'
    try {
      expect(getOakRoot()).toBe(path.join('/custom/work', OAK_ROOT_SEGMENT))
      expect(deriveAgentConfigDir()).toBe(path.join('/custom/work', OAK_ROOT_SEGMENT, 'agent', '.claude'))
    } finally {
      if (prev === undefined) delete process.env.OAK_SESSION_LOCAL_DIR
      else process.env.OAK_SESSION_LOCAL_DIR = prev
    }
  })
})
