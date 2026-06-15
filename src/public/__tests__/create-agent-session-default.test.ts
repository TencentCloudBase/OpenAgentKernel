import { describe, expect, it } from 'vitest'
import { createAgent } from '../create-agent.js'
import type { AgentConfig } from '../types.js'

const baseConfig: AgentConfig = {
  envId: 'env-test',
  model: 'glm-5.1',
  credentials: {
    secretId: 'sid',
    secretKey: 'sk',
  },
}

describe('createAgent — default session store', () => {
  it('enables CloudBase FlexDB session store by default when credentials are provided', async () => {
    const agent = createAgent(baseConfig)

    await expect(agent.resumeSession('conversation-id')).resolves.toMatchObject({
      id: 'conversation-id',
    })
  })

  it('allows disabling the default session store', async () => {
    const agent = createAgent({ ...baseConfig, session: { enabled: false } })

    await expect(agent.resumeSession('conversation-id')).rejects.toThrow(/session\.store/)
  })

  it('supports explicit provider="cloudbase" and database="flexdb"', async () => {
    const agent = createAgent({ ...baseConfig, session: { provider: 'cloudbase', database: 'flexdb' } })

    await expect(agent.resumeSession('conversation-id')).resolves.toMatchObject({
      id: 'conversation-id',
    })
  })

  it('defaults credentials.envId from AgentConfig.envId', async () => {
    const agent = createAgent({
      envId: 'env-from-agent',
      model: 'glm-5.1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
    })

    await expect(agent.resumeSession('conversation-id')).resolves.toMatchObject({
      id: 'conversation-id',
    })
  })

  it('requires credentials when session.enabled=true uses the default CloudBase FlexDB store', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        session: { enabled: true },
      }),
    ).toThrow(/requires AgentConfig\.credentials/)
  })

  it('rejects reserved CloudBase database types until their drivers are implemented', () => {
    expect(() => createAgent({ ...baseConfig, session: { database: 'mysql' } })).toThrow(/reserved for future/)
  })
})
