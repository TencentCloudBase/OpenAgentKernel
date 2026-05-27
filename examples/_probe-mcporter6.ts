import './_shared/env.js'
import { AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const runtime = new AgsStatefulSandbox()
  const sandbox = await runtime.acquire({
    envId: process.env.TCB_ENV_ID!,
    conversationId: 'probe7',
    scope: 'session',
  })

  // 看看 mcporter 是否有 --no-truncate 之类的选项
  const help = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'mcporter list --help 2>&1', timeout: 10_000 }),
  })
  const helpData = (await help.json()) as { result?: { output?: string } }
  console.log('=== mcporter list --help ===')
  console.log(helpData.result?.output)

  // 看真实 schema 文件中 truncated 字段长什么样
  const grep = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command:
        'grep -c "truncated to 2000 chars" .oak-cb-schema.json 2>&1; grep -n "truncated to 2000 chars" .oak-cb-schema.json | head -3 2>&1',
      timeout: 10_000,
    }),
  })
  const grepData = (await grep.json()) as { result?: { output?: string } }
  console.log('=== grep truncated ===')
  console.log(grepData.result?.output)

  await sandbox.release()
}
main().catch(console.error)
