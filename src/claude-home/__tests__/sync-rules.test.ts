import { describe, it, expect } from 'vitest'
import { matchesSyncRule, SYNC_INCLUDES } from '../sync-rules.js'

describe('SYNC_INCLUDES', () => {
  it('contains the expected three patterns', () => {
    expect(SYNC_INCLUDES).toEqual([
      'CLAUDE.md',
      'projects/*/memory/**',
      'agent-memory/**/MEMORY.md',
    ])
  })
})

describe('matchesSyncRule', () => {
  it('matches CLAUDE.md at root', () => {
    expect(matchesSyncRule('CLAUDE.md')).toBe(true)
  })

  it('does not match nested CLAUDE.md', () => {
    // 项目级 CLAUDE.md 不在 CONFIG_DIR 同步范围(走 cwd)
    expect(matchesSyncRule('subdir/CLAUDE.md')).toBe(false)
  })

  it('matches main session auto-memory files', () => {
    expect(matchesSyncRule('projects/abc123/memory/MEMORY.md')).toBe(true)
    expect(matchesSyncRule('projects/abc123/memory/debugging.md')).toBe(true)
    expect(matchesSyncRule('projects/abc123/memory/nested/deep.md')).toBe(true)
  })

  it('does not match projects without memory subdir', () => {
    expect(matchesSyncRule('projects/abc123/transcripts/foo.jsonl')).toBe(false)
    expect(matchesSyncRule('projects/abc123/foo.md')).toBe(false)
  })

  it('matches user-level subagent memory', () => {
    expect(matchesSyncRule('agent-memory/code-reviewer/MEMORY.md')).toBe(true)
    expect(matchesSyncRule('agent-memory/nested/path/MEMORY.md')).toBe(true)
  })

  it('does not match non-MEMORY.md files in agent-memory', () => {
    expect(matchesSyncRule('agent-memory/code-reviewer/notes.md')).toBe(false)
  })

  it('rejects platform assets', () => {
    expect(matchesSyncRule('settings.json')).toBe(false)
    expect(matchesSyncRule('skills/foo/SKILL.md')).toBe(false)
    expect(matchesSyncRule('commands/deploy.md')).toBe(false)
    expect(matchesSyncRule('rules/api.md')).toBe(false)
    expect(matchesSyncRule('agents/code-reviewer.md')).toBe(false)
  })

  it('rejects .claude.json (contains OAuth/IDE state)', () => {
    expect(matchesSyncRule('.claude.json')).toBe(false)
  })

  it('rejects empty path and absolute paths', () => {
    expect(matchesSyncRule('')).toBe(false)
    expect(matchesSyncRule('/absolute/CLAUDE.md')).toBe(false)
  })
})
