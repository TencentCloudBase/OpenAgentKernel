import './_shared/env.js'
import { AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const runtime = new AgsStatefulSandbox()
  const sandbox = await runtime.acquire({
    envId: process.env.TCB_ENV_ID!,
    conversationId: 'probe2',
    scope: 'session',
  })

  const res = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'mcporter list cloudbase --schema --output json 2>&1',
      timeout: 30_000,
    }),
  })
  const data = (await res.json()) as { result?: { stdout?: string; output?: string } }
  const r = data.result ?? {}
  const stdout = String(r.stdout ?? r.output ?? '')
  console.log('stdout length:', stdout.length)
  console.log('first 200 chars:', JSON.stringify(stdout.slice(0, 200)))
  console.log('last 200 chars:', JSON.stringify(stdout.slice(-200)))
  const jsonStart = stdout.indexOf('{')
  console.log('jsonStart:', jsonStart)
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart)) as { tools?: unknown[] }
    console.log('parsed OK, tools.length =', parsed.tools?.length)
    console.log(
      'first 3 tool names:',
      parsed.tools?.slice(0, 3).map((t) => (t as { name?: string }).name),
    )
  } catch (e) {
    console.log('parse error:', (e as Error).message)
    // 找出第一个 parse 失败的位置
    for (let i = stdout.length; i > jsonStart; i -= 1000) {
      try {
        JSON.parse(stdout.slice(jsonStart, i))
        console.log('parses OK with truncated length:', i - jsonStart)
        break
      } catch {
        // continue
      }
    }
  }
  await sandbox.release()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
