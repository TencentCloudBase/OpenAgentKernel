import { describe, it, expect } from 'vitest'
import { matchesCwdSyncRule, shouldPruneCwdDir, DEFAULT_CWD_EXCLUDES } from '../workspace-cwd-rules.js'

describe('shouldPruneCwdDir', () => {
  it('prunes default excluded top dirs', () => {
    expect(shouldPruneCwdDir('node_modules')).toBe(true)
    expect(shouldPruneCwdDir('.git')).toBe(true)
    expect(shouldPruneCwdDir('.oak')).toBe(true)
    expect(shouldPruneCwdDir('.claude')).toBe(true)
    expect(shouldPruneCwdDir('dist')).toBe(true)
  })

  it('does not prune normal dirs', () => {
    expect(shouldPruneCwdDir('src')).toBe(false)
    expect(shouldPruneCwdDir('docs')).toBe(false)
  })

  it('honors extra dir excludes', () => {
    expect(shouldPruneCwdDir('tmp', { extraExcludes: ['tmp'] })).toBe(true)
    expect(shouldPruneCwdDir('tmp')).toBe(false)
  })
})

describe('matchesCwdSyncRule', () => {
  it('allows normal source files', () => {
    expect(matchesCwdSyncRule('src/index.ts')).toBe(true)
    expect(matchesCwdSyncRule('README.md')).toBe(true)
    expect(matchesCwdSyncRule('a/b/c/file.txt')).toBe(true)
  })

  it('excludes files under blacklisted dirs', () => {
    expect(matchesCwdSyncRule('node_modules/foo/index.js')).toBe(false)
    expect(matchesCwdSyncRule('.git/config')).toBe(false)
    expect(matchesCwdSyncRule('dist/bundle.js')).toBe(false)
    expect(matchesCwdSyncRule('.oak/agent/.claude/settings.json')).toBe(false)
  })

  it('excludes noise suffixes', () => {
    expect(matchesCwdSyncRule('debug.log')).toBe(false)
    expect(matchesCwdSyncRule('foo.tmp')).toBe(false)
  })

  it('rejects path traversal and absolute paths', () => {
    expect(matchesCwdSyncRule('../escape')).toBe(false)
    expect(matchesCwdSyncRule('/abs/path')).toBe(false)
    expect(matchesCwdSyncRule('')).toBe(false)
  })

  it('honors extra dir excludes and suffix excludes', () => {
    expect(matchesCwdSyncRule('tmp/x.txt', { extraExcludes: ['tmp'] })).toBe(false)
    expect(matchesCwdSyncRule('x.bak', { extraExcludes: ['*.bak'] })).toBe(false)
    expect(matchesCwdSyncRule('x.bak')).toBe(true) // not excluded by default
  })

  it('DEFAULT_CWD_EXCLUDES contains the critical kernel dirs', () => {
    expect(DEFAULT_CWD_EXCLUDES).toContain('.oak')
    expect(DEFAULT_CWD_EXCLUDES).toContain('.claude')
    expect(DEFAULT_CWD_EXCLUDES).toContain('node_modules')
  })
})
