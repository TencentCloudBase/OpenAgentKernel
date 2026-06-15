import { describe, it, expect } from 'vitest'
import { matchesSyncRule, SYNC_INCLUDES } from '../sync-rules.js'

describe('SYNC_INCLUDES', () => {
  it('contains the documented patterns', () => {
    expect(SYNC_INCLUDES).toEqual(['CLAUDE.md', 'projects/*/memory/**/*.md', 'agent-memory/**/*.md'])
  })
})

describe('matchesSyncRule — 白名单(应同步)', () => {
  it('matches CLAUDE.md at root', () => {
    expect(matchesSyncRule('CLAUDE.md')).toBe(true)
  })

  it('matches main session auto-memory files (projects/<id>/memory/**.md)', () => {
    expect(matchesSyncRule('projects/abc123/memory/MEMORY.md')).toBe(true)
    expect(matchesSyncRule('projects/abc123/memory/debugging.md')).toBe(true)
    expect(matchesSyncRule('projects/abc123/memory/nested/deep.md')).toBe(true)
  })

  it('matches all .md under agent-memory/ (用户级 subagent memory)', () => {
    expect(matchesSyncRule('agent-memory/code-reviewer/MEMORY.md')).toBe(true)
    expect(matchesSyncRule('agent-memory/nested/path/MEMORY.md')).toBe(true)
    // 放宽 v3.1 限制:notes.md 等非 MEMORY.md 也同步(只要在 agent-memory 下)
    expect(matchesSyncRule('agent-memory/code-reviewer/notes.md')).toBe(true)
  })
})

describe('matchesSyncRule — 黑名单(不应同步)', () => {
  it('rejects nested CLAUDE.md (only root CLAUDE.md is user-level)', () => {
    expect(matchesSyncRule('subdir/CLAUDE.md')).toBe(false)
  })

  it('rejects projects without memory subdir', () => {
    expect(matchesSyncRule('projects/abc123/foo.md')).toBe(false)
    expect(matchesSyncRule('projects/abc123/transcripts/foo.md')).toBe(false)
  })

  it('rejects all .jsonl (session transcripts handled by SessionStore)', () => {
    expect(matchesSyncRule('history.jsonl')).toBe(false)
    expect(matchesSyncRule('projects/abc/9262a138-e0b1.jsonl')).toBe(false)
    expect(matchesSyncRule('projects/abc/memory/notes.jsonl')).toBe(false)
    expect(matchesSyncRule('agent-memory/foo/log.jsonl')).toBe(false)
  })

  it('rejects all .json (settings / .claude.json / config files)', () => {
    expect(matchesSyncRule('settings.json')).toBe(false)
    expect(matchesSyncRule('settings.local.json')).toBe(false)
    expect(matchesSyncRule('keybindings.json')).toBe(false)
    expect(matchesSyncRule('.claude.json')).toBe(false)
    expect(matchesSyncRule('backups/.claude.json.backup.123')).toBe(false)
  })

  it('rejects platform asset directories (skills/rules/commands/agents/etc)', () => {
    expect(matchesSyncRule('skills/foo/SKILL.md')).toBe(false)
    expect(matchesSyncRule('skills/foo/checklist.md')).toBe(false)
    expect(matchesSyncRule('rules/api.md')).toBe(false)
    expect(matchesSyncRule('commands/deploy.md')).toBe(false)
    expect(matchesSyncRule('agents/code-reviewer.md')).toBe(false)
    expect(matchesSyncRule('output-styles/teaching.md')).toBe(false)
    expect(matchesSyncRule('themes/dark.md')).toBe(false)
    expect(matchesSyncRule('plugins/foo/SKILL.md')).toBe(false)
  })

  it('rejects SDK internal state and caches', () => {
    expect(matchesSyncRule('.last-cleanup')).toBe(false)
    expect(matchesSyncRule('backups/anything.md')).toBe(false)
    expect(matchesSyncRule('cache/foo.md')).toBe(false)
    expect(matchesSyncRule('shell-snapshots/foo.md')).toBe(false)
    expect(matchesSyncRule('statsig/foo.md')).toBe(false)
    expect(matchesSyncRule('telemetry/foo.md')).toBe(false)
    expect(matchesSyncRule('debug/foo.md')).toBe(false)
    expect(matchesSyncRule('downloads/foo.md')).toBe(false)
  })

  it('rejects per-process runtime state', () => {
    expect(matchesSyncRule('ide/lockfile.md')).toBe(false)
    expect(matchesSyncRule('session-env/foo.md')).toBe(false)
    expect(matchesSyncRule('sessions/foo.md')).toBe(false)
    expect(matchesSyncRule('todos/foo.md')).toBe(false)
  })

  it('does not match prefix-similar dirs (myskills not skills)', () => {
    // myskills 不应被当成 skills 排除(prefix 误匹配防御)
    expect(matchesSyncRule('myskills/note.md')).toBe(false)
    // 上面是 false 是因为它不在白名单(不是 CLAUDE.md / projects/ / agent-memory/)
    // 但要确认它不是被 skills 排除规则误匹配。换一个白名单内的 prefix 测:
    expect(matchesSyncRule('agent-memory-archive/note.md')).toBe(false) // 不是 agent-memory/
  })

  it('rejects empty path and absolute paths', () => {
    expect(matchesSyncRule('')).toBe(false)
    expect(matchesSyncRule('/absolute/CLAUDE.md')).toBe(false)
  })

  it('rejects path traversal segments', () => {
    expect(matchesSyncRule('../escape.md')).toBe(false)
    expect(matchesSyncRule('CLAUDE.md/../etc')).toBe(false)
  })
})
