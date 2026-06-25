/**
 * Example 21: default session stream contract.
 *
 * This example is type-level only: it verifies that Session.send() and
 * respond*() methods expose AsyncIterable<AcpSessionUpdate> by default.
 *
 * Verify after build:
 *   pnpm --filter @cloudbase/open-agent-kernel build
 *   pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck packages/open-agent-kernel/examples/21-default-acp-session-contract.ts
 */
import type { AcpSessionUpdate, Session } from '@cloudbase/open-agent-kernel'

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type SendReturnsAcp = Assert<Equal<ReturnType<Session['send']>, AsyncIterable<AcpSessionUpdate>>>
type ApprovalReturnsAcp = Assert<Equal<ReturnType<Session['respondApproval']>, AsyncIterable<AcpSessionUpdate>>>
type ToolUseReturnsAcp = Assert<Equal<ReturnType<Session['respondToolUse']>, AsyncIterable<AcpSessionUpdate>>>
type AskUserReturnsAcp = Assert<Equal<ReturnType<Session['respondAskUser']>, AsyncIterable<AcpSessionUpdate>>>

const checks: [SendReturnsAcp, ApprovalReturnsAcp, ToolUseReturnsAcp, AskUserReturnsAcp] = [true, true, true, true]

void checks
