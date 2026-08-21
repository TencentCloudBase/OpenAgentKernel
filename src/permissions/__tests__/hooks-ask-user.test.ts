/**
 * Native AskUserQuestion HITL: first call denies; resume injects answers.
 */
import { describe, it, expect } from 'vitest'
import {
  createHookLocalState,
  createPreToolUsePermissionHook,
  normalizeAskUserAnswers,
  OAK_CLIENT_TOOL_SENTINEL,
  parseClientToolSignal,
} from '../hooks.js'
import { InMemoryClientToolStore } from '../store.js'

const conversationId = 'conv-1'
const questionsInput = {
  questions: [
    {
      question: 'Which library should we use for date formatting?',
      header: 'Library',
      options: [
        { label: 'date-fns', description: 'Small, functional' },
        { label: 'dayjs', description: 'Moment-compatible' },
      ],
      multiSelect: false,
    },
  ],
}

function abortOpts() {
  return { signal: new AbortController().signal }
}

function makeHook(store: InMemoryClientToolStore, localState = createHookLocalState()) {
  return createPreToolUsePermissionHook({
    conversationId,
    permissions: { requireApproval: undefined },
    localState,
    clientToolStore: store,
  })
}

describe('normalizeAskUserAnswers', () => {
  it('passes through native answers map', () => {
    const answers = { 'Which library should we use for date formatting?': 'date-fns' }
    expect(normalizeAskUserAnswers({ answers }, questionsInput)).toEqual(answers)
  })

  it('maps legacy { answer } onto the first question text', () => {
    expect(normalizeAskUserAnswers({ answer: 'date-fns' }, questionsInput)).toEqual({
      'Which library should we use for date formatting?': 'date-fns',
    })
  })

  it('maps a plain string onto the first question text', () => {
    expect(normalizeAskUserAnswers('date-fns', questionsInput)).toEqual({
      'Which library should we use for date formatting?': 'date-fns',
    })
  })

  it('joins multi-select array values with comma-space', () => {
    expect(
      normalizeAskUserAnswers(
        { answers: { Q: ['A', 'B'] } },
        { questions: [{ question: 'Q' }] },
      ),
    ).toEqual({ Q: 'A, B' })
  })
})

describe('PreToolUse AskUserQuestion', () => {
  it('first call denies with client-tool sentinel and stores pending', async () => {
    const store = new InMemoryClientToolStore()
    const hook = makeHook(store)
    const out = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: questionsInput,
        tool_use_id: 'id-1',
      },
      'id-1',
      abortOpts(),
    )

    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } })
      .hookSpecificOutput
    expect(decision?.permissionDecision).toBe('deny')
    expect(decision?.permissionDecisionReason).toContain(OAK_CLIENT_TOOL_SENTINEL)
    const signal = parseClientToolSignal(decision?.permissionDecisionReason ?? '')
    expect(signal?.toolName).toBe('AskUserQuestion')
    expect(signal?.toolUseId).toBe('id-1')

    const pending = await store.get({ conversationId, toolUseId: 'id-1' })
    expect(pending?.toolInput).toEqual(questionsInput)
    expect(pending?.result).toBeUndefined()
  })

  it('resume injects updatedInput.answers from the store and deletes the entry', async () => {
    const store = new InMemoryClientToolStore()
    await store.put({
      conversationId,
      toolUseId: 'id-1',
      toolName: 'AskUserQuestion',
      toolInput: questionsInput,
      result: {
        output: { answers: { 'Which library should we use for date formatting?': 'date-fns' } },
        isError: false,
      },
      createdAt: Date.now(),
    })
    const hook = makeHook(store)
    const out = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: questionsInput,
        tool_use_id: 'id-2',
      },
      'id-2',
      abortOpts(),
    )

    const specific = (out as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } })
      .hookSpecificOutput
    expect(specific?.permissionDecision).toBe('allow')
    expect(specific?.updatedInput?.answers).toEqual({
      'Which library should we use for date formatting?': 'date-fns',
    })
    expect(await store.get({ conversationId, toolUseId: 'id-1' })).toBeNull()
  })

  it('resume maps legacy { answer } onto the question text', async () => {
    const store = new InMemoryClientToolStore()
    await store.put({
      conversationId,
      toolUseId: 'id-1',
      toolName: 'AskUserQuestion',
      toolInput: questionsInput,
      result: { output: { answer: 'dayjs' }, isError: false },
      createdAt: Date.now(),
    })
    const hook = makeHook(store)
    const out = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: questionsInput,
        tool_use_id: 'id-2',
      },
      'id-2',
      abortOpts(),
    )
    const specific = (out as { hookSpecificOutput?: { updatedInput?: { answers?: Record<string, string> } } })
      .hookSpecificOutput
    expect(specific?.updatedInput?.answers).toEqual({
      'Which library should we use for date formatting?': 'dayjs',
    })
  })

  it('resume prefers seed over store and still deletes the original entry', async () => {
    const store = new InMemoryClientToolStore()
    await store.put({
      conversationId,
      toolUseId: 'id-1',
      toolName: 'AskUserQuestion',
      toolInput: questionsInput,
      result: { output: { answer: 'stale-from-store' }, isError: false },
      createdAt: Date.now(),
    })
    const localState = createHookLocalState({
      toolName: 'AskUserQuestion',
      originalToolUseId: 'id-1',
      result: {
        output: { answers: { 'Which library should we use for date formatting?': 'date-fns' } },
        isError: false,
      },
      toolInput: questionsInput,
    })
    const hook = makeHook(store, localState)
    const out = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: questionsInput,
        tool_use_id: 'id-2',
      },
      'id-2',
      abortOpts(),
    )
    const specific = (out as { hookSpecificOutput?: { updatedInput?: { answers?: Record<string, string> } } })
      .hookSpecificOutput
    expect(specific?.updatedInput?.answers).toEqual({
      'Which library should we use for date formatting?': 'date-fns',
    })
    expect(localState.seededClientToolResult).toBeUndefined()
    expect(await store.get({ conversationId, toolUseId: 'id-1' })).toBeNull()
  })

  it('custom client-tool resume still returns {} so the MCP stub can read the store', async () => {
    const store = new InMemoryClientToolStore()
    await store.put({
      conversationId,
      toolUseId: 'id-1',
      toolName: 'get_weather',
      toolInput: { city: 'SZ' },
      result: { output: { temp: 30 }, isError: false },
      createdAt: Date.now(),
    })
    const hook = createPreToolUsePermissionHook({
      conversationId,
      permissions: { requireApproval: undefined },
      localState: createHookLocalState(),
      clientToolNames: new Set(['get_weather']),
      clientToolStore: store,
    })
    const out = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__custom__get_weather',
        tool_input: { city: 'SZ' },
        tool_use_id: 'id-2',
      },
      'id-2',
      abortOpts(),
    )
    expect(out).toEqual({})
    expect(await store.get({ conversationId, toolUseId: 'id-1' })).not.toBeNull()
  })
})
