/**
 * Example 21: Local Runtime CloudBase MCP (in-process)
 *
 * This validates the Phase 2 local CloudBase MCP path without AGS/TRW:
 *   - import @cloudbase/cloudbase-mcp in the OAK process
 *   - connect with in-memory MCP transport
 *   - expose all discovered CloudBase tools as an SDK MCP server
 *
 * It only checks tool discovery. It does not call real CloudBase write tools.
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/21-local-cloudbase-mcp.ts
 */
import { getEnvId, getPlatformCredentials } from './_shared/env.js'

import { createCloudBaseMcpServerInProcess } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()

  const bundle = await createCloudBaseMcpServerInProcess({
    workspaceFolderPaths: process.cwd(),
    getCredentials: async () => ({
      envId,
      secretId: credentials.secretId,
      secretKey: credentials.secretKey,
      sessionToken: credentials.sessionToken,
    }),
  })

  if (bundle.toolCount <= 0) {
    throw new Error(`Expected CloudBase MCP tools, got degradedReason=${bundle.degradedReason ?? '<none>'}`)
  }

  console.log(`CloudBase MCP in-process tools discovered: ${bundle.toolCount}`)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
