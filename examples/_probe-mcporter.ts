/**
 * 调试脚本：直接用 sandbox 跑 mcporter list 看输出格式
 */
import { getEnvId, getPlatformCredentials, getSandboxApiKey } from './_shared/env.js'

import { AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()

  const runtime = new AgsStatefulSandbox({ apiKey: getSandboxApiKey() })
  const sandbox = await runtime.acquire({
    envId,
    credentials,
    conversationId: 'debug-mcporter',
    scope: 'session',
    onProgress: (m) => console.log('[probe]', m.phase, m.message),
  })

  const probe = async (label: string, cmd: string): Promise<void> => {
    console.log(`\n=== ${label} ===`)
    console.log(`$ ${cmd}`)
    const res = await sandbox.request('/api/tools/bash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd, timeout: 30_000 }),
    })
    const data = (await res.json()) as {
      success: boolean
      result?: { stdout?: string; stderr?: string; exitCode?: number; output?: string }
    }
    const r = data.result ?? {}
    console.log('exitCode:', r.exitCode)
    console.log('stdout (first 2000 chars):')
    console.log((r.stdout ?? r.output ?? '').slice(0, 2000))
    if (r.stderr) {
      console.log('stderr (first 500 chars):')
      console.log(r.stderr.slice(0, 500))
    }
  }

  await probe('which mcporter', 'which mcporter')
  await probe('mcporter --version', 'mcporter --version 2>&1')
  await probe('mcporter list (no args)', 'mcporter list 2>&1 | head -50')
  await probe('mcporter list cloudbase --help', 'mcporter list cloudbase --help 2>&1 | head -50')
  await probe(
    'mcporter list cloudbase --schema --output json',
    'mcporter list cloudbase --schema --output json 2>&1 | head -200',
  )

  await sandbox.release()
  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
