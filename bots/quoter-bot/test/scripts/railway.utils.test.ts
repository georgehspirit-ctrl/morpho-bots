import { getChainAddress } from '@morpho-org/morpho-ts'
import { readFileSync } from 'node:fs'
import { base } from 'viem/chains'
import { describe, expect, test, vi } from 'vitest'

import { RailwayDeploymentError } from '../../scripts/railway-deployment.error'
import {
  assertFreshRailwayReferenceProvisioning,
  assertFullRailwaySignerProvisioning,
  isNonEmptyJsonArray,
  isTerminalRailwayDeploymentStatus,
  missingRailwayServices,
  parseStartedRailwayDeploymentId,
  parseRailwayServices,
  parseRailwayVolumes,
  railwayServiceName,
  reshipRailwayServices,
  selectRailwayDeploymentById,
  synchronizedOptionalRailwayVariables
} from '../../scripts/railway.utils'
import { requiresMaxRatificationGas } from '../../src/config/write-policy.utils'

type DockerInstruction = { keyword: string; value: string }

const parseDockerfile = (source: string): DockerInstruction[] => {
  const instructions: DockerInstruction[] = []
  let logicalLine = ''

  for (const physicalLine of source.split(/\r?\n/)) {
    const trimmed = physicalLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    logicalLine += `${logicalLine ? ' ' : ''}${trimmed.replace(/\\$/, '').trimEnd()}`
    if (trimmed.endsWith('\\')) continue

    const match = logicalLine.match(/^(\S+)\s+(.+)$/)
    if (!match) throw new Error(`Invalid Dockerfile instruction: ${logicalLine}`)
    instructions.push({ keyword: match[1]!.toUpperCase(), value: match[2]!.trim() })
    logicalLine = ''
  }

  if (logicalLine) throw new Error(`Unterminated Dockerfile instruction: ${logicalLine}`)
  return instructions
}

const parseShellStatements = (source: string): string[] => {
  const statements: string[] = []
  let logicalLine = ''

  for (const physicalLine of source.split(/\r?\n/)) {
    const trimmed = physicalLine.trim()
    if (!logicalLine && (!trimmed || (trimmed.startsWith('#') && trimmed !== '#!/bin/sh'))) continue
    if (!logicalLine && /^\s/.test(physicalLine)) {
      throw new Error(`Indented shell statement: ${physicalLine}`)
    }

    logicalLine += `${logicalLine ? ' ' : ''}${trimmed.replace(/\\$/, '').trimEnd()}`
    if (trimmed.endsWith('\\')) continue

    statements.push(logicalLine)
    logicalLine = ''
  }

  if (logicalLine) throw new Error(`Unterminated shell statement: ${logicalLine}`)
  return statements
}

describe('Railway CLI output parsing', () => {
  test('fails closed for signer modes that require out-of-band Railway provisioning', () => {
    expect(() => assertFullRailwaySignerProvisioning('private-key')).not.toThrow()
    expect(() => assertFullRailwaySignerProvisioning('keystore')).toThrow(
      'Keystore Railway deployment requires a pre-provisioned file; use DEPLOY_ONLY=true'
    )
    expect(() => assertFullRailwaySignerProvisioning('aws')).toThrow(
      'AWS KMS Railway deployment requires pre-provisioned credentials; use DEPLOY_ONLY=true'
    )
  })

  test('requires a ratification gas ceiling only for local Setter signing', () => {
    const setter = getChainAddress(base.id, 'setterRatifier')
    const ecrecover = getChainAddress(base.id, 'ecrecoverRatifier')

    expect(requiresMaxRatificationGas('private-key', setter, base.id)).toBe(true)
    expect(requiresMaxRatificationGas('keystore', setter, base.id)).toBe(true)
    expect(requiresMaxRatificationGas('aws', setter, base.id)).toBe(false)
    expect(requiresMaxRatificationGas('private-key', ecrecover, base.id)).toBe(false)
  })

  test('identifies only populated JSON arrays as deployable strategy lists', () => {
    expect(isNonEmptyJsonArray('[{"marketId":"configured"}]')).toBe(true)
    expect(isNonEmptyJsonArray('[]')).toBe(false)
    expect(isNonEmptyJsonArray('{"marketId":"configured"}')).toBe(false)
    expect(isNonEmptyJsonArray('not-json')).toBe(false)
  })

  test('parses named services from array and wrapped response shapes', () => {
    const array = JSON.stringify([{ id: 'service-id', name: 'quoter-bot' }, { id: 'nameless' }])
    const wrapped = JSON.stringify({
      services: [{ id: 'service-id', serviceName: 'quoter-bot' }]
    })
    const created = JSON.stringify({ id: 'service-id', name: 'quoter-bot' })

    expect(parseRailwayServices(array)).toEqual([{ id: 'service-id', name: 'quoter-bot' }])
    expect(parseRailwayServices(wrapped)).toEqual([{ id: 'service-id', name: 'quoter-bot' }])
    expect(parseRailwayServices(created)).toEqual([{ id: 'service-id', name: 'quoter-bot' }])
  })

  test('returns no services for malformed JSON', () => {
    expect(parseRailwayServices('not-json')).toEqual([])
  })

  test('parses only complete attached Railway volumes', () => {
    const raw = JSON.stringify({
      volumes: [
        {
          id: 'volume-id',
          isPendingDeletion: false,
          mountPath: '/state',
          serviceName: 'quoter-bot'
        },
        {
          id: 'unattached',
          isPendingDeletion: false,
          mountPath: '/legacy',
          name: 'market-making-volume',
          serviceName: null
        },
        { id: 'incomplete', mountPath: '/other', serviceName: 'quoter-bot' }
      ]
    })

    expect(parseRailwayVolumes(raw)).toEqual([
      {
        id: 'volume-id',
        isPendingDeletion: false,
        mountPath: '/state',
        serviceName: 'quoter-bot'
      }
    ])
    expect(parseRailwayVolumes('not-json')).toEqual([])
  })

  test('requires Blue references when provisioning a fresh variable-rate service', () => {
    const environment = {
      BOOTSTRAP_MARKETS: JSON.stringify([
        { marketId: 'configured', targetRate: { strategy: 'variable_rate_avg' } }
      ]),
      LADDER_MARKETS: JSON.stringify([
        {
          marketId: 'configured',
          targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
        }
      ])
    }

    expect(() => assertFreshRailwayReferenceProvisioning(environment, true)).toThrow(
      'Missing required environment variable: REFERENCE_RPC_URL'
    )
    expect(() => assertFreshRailwayReferenceProvisioning(environment, false)).not.toThrow()
    expect(() =>
      assertFreshRailwayReferenceProvisioning(
        {
          ...environment,
          REFERENCE_RPC_URL: 'https://archive.example',
          REFERENCE_MARKET_ID: '0xreference'
        },
        true
      )
    ).not.toThrow()
  })

  test('checks fresh-service references before Railway can create the service', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')

    expect(
      deploy.indexOf('assertFreshRailwayReferenceProvisioning(process.env, true)')
    ).toBeGreaterThan(-1)
    expect(
      deploy.indexOf('assertFreshRailwayReferenceProvisioning(process.env, true)')
    ).toBeLessThan(deploy.indexOf('railway add --service'))
  })

  test('keeps the root entrypoint immutable and strictly limits privileged startup', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
    const entrypoint = readFileSync(
      new URL('../../scripts/railway-entrypoint.sh', import.meta.url),
      'utf8'
    )
    const contextSetup = deploy.indexOf('await ensureContext()')
    const fullProvisioningBranch = deploy.indexOf(
      'const service = railwayServiceName(chainIdValue(process.env))'
    )
    const ensureService = deploy.indexOf('await ensureService(service)', fullProvisioningBranch)
    const deployOnlySource = deploy.slice(contextSetup, fullProvisioningBranch)
    const fullProvisioningRuntimeUid = deploy.indexOf(
      "await setRuntimeVariable(service, ['RAILWAY_RUN_UID', '0'])",
      fullProvisioningBranch
    )
    const instructions = parseDockerfile(dockerfile)
    const froms = instructions
      .map((instruction, index) => ({ ...instruction, index }))
      .filter(({ keyword }) => keyword === 'FROM')
    const runtimeFrom = froms[1]!.index
    const buildStage = instructions.slice(0, runtimeFrom)
    const runtimeStage = instructions.slice(runtimeFrom + 1)
    const buildUsers = buildStage
      .map((instruction, index) => ({ ...instruction, index }))
      .filter(({ keyword }) => keyword === 'USER')
    const userNode = buildUsers[0]!.index
    const requiredNodeRuns = [
      'corepack install',
      'pnpm install --frozen-lockfile',
      'pnpm -r --if-present run build'
    ]

    expect(contextSetup).toBeGreaterThan(-1)
    expect(deployOnlySource).not.toContain('setRuntimeVariable(')
    expect(fullProvisioningRuntimeUid).toBeGreaterThan(ensureService)
    expect(fullProvisioningRuntimeUid).toBeLessThan(
      deploy.indexOf('await startDeployment(service)', fullProvisioningBranch)
    )

    // Two stages: the workspace builds in `build`; the runtime stage ships only the bot's bundle.
    expect(froms.map(({ value }) => value)).toEqual([
      'node:24.14.1-slim AS build',
      'node:24.14.1-slim'
    ])

    // Build stage: every workspace install and build step runs unprivileged after USER node.
    expect(buildUsers.map(({ value }) => value)).toEqual(['node'])
    for (const command of requiredNodeRuns) {
      const runIndex = buildStage.findIndex(
        ({ keyword, value }) => keyword === 'RUN' && value === command
      )
      expect(runIndex).toBeGreaterThan(userNode)
    }

    // Runtime stage, exactly: no USER switch (the container must start as root so the entrypoint
    // can repair Railway's root-owned volume before setpriv drops privileges), setpriv and the
    // state mount as the only RUNs, and no content beyond the bot's built output and the
    // root-owned, non-writable entrypoint — the image publishes publicly, so no other bot's code,
    // workspace source, or package manager may ship.
    expect(runtimeStage).toEqual([
      { keyword: 'ENV', value: 'HOME=/home/node' },
      {
        keyword: 'RUN',
        value:
          '/usr/bin/apt-get update && /usr/bin/apt-get install -y --no-install-recommends util-linux && /usr/bin/rm -rf /var/lib/apt/lists/*'
      },
      { keyword: 'RUN', value: '/usr/bin/mkdir -p /state' },
      {
        keyword: 'COPY',
        value:
          '--from=build --chown=0:0 --chmod=0555 /repo/bots/quoter-bot/package.json /repo/bots/quoter-bot/package.json'
      },
      {
        keyword: 'COPY',
        value:
          '--from=build --chown=0:0 --chmod=0555 /repo/bots/quoter-bot/dist /repo/bots/quoter-bot/dist'
      },
      {
        keyword: 'COPY',
        value:
          '--chown=0:0 --chmod=0555 bots/quoter-bot/scripts/railway-entrypoint.sh /usr/local/sbin/railway-entrypoint.sh'
      },
      { keyword: 'WORKDIR', value: '/repo/bots/quoter-bot' },
      {
        keyword: 'CMD',
        value: '["/usr/local/sbin/railway-entrypoint.sh", "start", "--verbose"]'
      }
    ])
    expect(entrypoint.startsWith('#!/bin/sh\n')).toBe(true)
    expect(parseShellStatements(entrypoint)).toEqual([
      '#!/bin/sh',
      'set -eu',
      'STATE_MOUNT_PATH=/state',
      '/usr/bin/chown -R node:node "$STATE_MOUNT_PATH"',
      'exec /usr/bin/setpriv --reuid=node --regid=node --clear-groups --bounding-set=-all --no-new-privs /usr/local/bin/node dist/src/index.js "$@"'
    ])
  })

  test('creates fresh state only during authorized provisioning', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')
    const deployOnlyBranch = deploy.indexOf('if (DEPLOY_ONLY)')
    const fullProvisioningBranch = deploy.indexOf(
      'const service = railwayServiceName(chainIdValue(process.env))'
    )
    const ensureService = deploy.indexOf('await ensureService(service)', fullProvisioningBranch)
    const serviceLink = deploy.indexOf('await linkServiceContext(railwayService.id)')
    const runtimeUid = deploy.indexOf("await setRuntimeVariable(service, ['RAILWAY_RUN_UID', '0'])")
    const dockerfilePath = deploy.indexOf(
      "await setRuntimeVariable(service, ['RAILWAY_DOCKERFILE_PATH', DOCKERFILE_PATH])"
    )
    const stateHome = deploy.indexOf(
      "await setRuntimeVariable(service, ['XDG_STATE_HOME', STATE_MOUNT_PATH])"
    )
    const stateVolume = deploy.indexOf('await ensureStateVolume(service)')
    const deploymentStart = deploy.indexOf('const deploymentId = await startDeployment(service)')

    expect(deploy).toContain('if (process.env.RAILWAY_TOKEN) return')
    expect(deployOnlyBranch).toBeGreaterThan(-1)
    expect(fullProvisioningBranch).toBeGreaterThan(deployOnlyBranch)
    expect(deploy.slice(deployOnlyBranch, fullProvisioningBranch)).toContain('process.exit(')
    expect(ensureService).toBeGreaterThan(fullProvisioningBranch)
    expect(serviceLink).toBeGreaterThan(ensureService)
    expect(runtimeUid).toBeGreaterThan(serviceLink)
    expect(dockerfilePath).toBeGreaterThan(runtimeUid)
    expect(stateHome).toBeGreaterThan(dockerfilePath)
    expect(stateVolume).toBeGreaterThan(stateHome)
    expect(stateVolume).toBeLessThan(deploymentStart)
    expect(deploy).toContain('--detach --json')
    expect(deploy).toContain('--limit ${DEPLOYMENT_LIST_LIMIT} --json')
    expect(deploy).toContain('railway volume list --json')
    expect(deploy).not.toContain('railway volume list --service')
    expect(deploy).not.toContain('railway volume update')
    expect(deploy).not.toContain('railway volume attach')
    expect(deploy).toContain('railway volume add --mount-path ${STATE_MOUNT_PATH} --json')
  })

  test('validates all runtime variables before mutating Railway configuration', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')
    const preflight = deploy.indexOf(
      'const configuredRuntimeVariables = DEPLOY_ONLY ? [] : runtimeVariables()'
    )
    const firstVariableWrite = deploy.indexOf(
      "await setRuntimeVariable(service, ['RAILWAY_RUN_UID', '0'])"
    )

    expect(preflight).toBeGreaterThan(-1)
    expect(preflight).toBeLessThan(firstVariableWrite)
    expect(deploy).toContain('for (const variable of configuredRuntimeVariables)')
  })

  test('synchronizes every optional variable with explicit safe defaults', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            marketId: 'configured',
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            marketId: 'configured',
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        REQUEST_TIMEOUT_MS: '25000'
      })
    )

    expect(variables).toEqual({
      BETTERSTACK_HEARTBEAT_URL: ' ',
      BETTERSTACK_INGESTING_HOST: ' ',
      BETTERSTACK_SOURCE_TOKEN: ' ',
      REFERENCE_LOOKBACK_SECONDS: ' ',
      REFERENCE_MARKET_ID: ' ',
      REFERENCE_RPC_URL: ' ',
      REQUEST_TIMEOUT_MS: '25000',
      TRANSACTION_RECEIPT_TIMEOUT_MS: '180000',
      V0_OFFER_GROUP_IDS: ' '
    })
  })

  test('trims optional reference configuration before uploading it to Railway', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        REFERENCE_RPC_URL: ' https://archive.example/ ',
        REFERENCE_MARKET_ID: ' 0xreference '
      })
    )

    expect(variables.REFERENCE_RPC_URL).toBe('https://archive.example/')
    expect(variables.REFERENCE_MARKET_ID).toBe('0xreference')
  })

  test('forwards a configured reference window without pinning its default', () => {
    // The window must reach Railway when an operator sets it, but the deploy path must not carry
    // the numeric default: that would be a second copy outliving a future change to the parser's.
    expect(
      Object.fromEntries(
        synchronizedOptionalRailwayVariables({ REFERENCE_LOOKBACK_SECONDS: ' 21600 ' })
      ).REFERENCE_LOOKBACK_SECONDS
    ).toBe('21600')
    expect(
      readFileSync(new URL('../../scripts/railway.utils.ts', import.meta.url), 'utf8')
    ).not.toContain('259200')
  })

  test('preserves an omitted reference window rather than clearing it under a variable rate', () => {
    const variables = Object.fromEntries(
      synchronizedOptionalRailwayVariables({
        LADDER_MARKETS: JSON.stringify([
          { marketId: 'configured', targetRate: { strategy: 'variable_rate_avg' } }
        ])
      })
    )

    expect(variables).not.toHaveProperty('REFERENCE_LOOKBACK_SECONDS')
  })

  test('preserves Railway reference variables when a workflow uses a variable rate', () => {
    for (const targetRate of [undefined, { strategy: 'variable_rate_avg' }]) {
      const variables = Object.fromEntries(
        synchronizedOptionalRailwayVariables({
          BOOTSTRAP_MARKETS: JSON.stringify([{ marketId: 'configured', targetRate }]),
          LADDER_MARKETS: JSON.stringify([
            {
              marketId: 'configured',
              targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
            }
          ])
        })
      )

      expect(variables).not.toHaveProperty('REFERENCE_RPC_URL')
      expect(variables).not.toHaveProperty('REFERENCE_MARKET_ID')
    }
  })

  test('allows Compose deployments to omit inactive reference configuration', () => {
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

    expect(compose).toContain('REFERENCE_RPC_URL: ${REFERENCE_RPC_URL:-}')
    expect(compose).toContain('REFERENCE_MARKET_ID: ${REFERENCE_MARKET_ID:-}')
    // Compose forwards only enumerated variables, so an unlisted window would strand a Compose
    // operator on the three-day default with no way to match their archive endpoint's retention.
    expect(compose).toContain('REFERENCE_LOOKBACK_SECONDS: ${REFERENCE_LOOKBACK_SECONDS:-}')
  })

  test('exposes optional configuration for each supported signer backend', () => {
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

    expect(compose).toContain('KEY_STORAGE_METHOD: ${KEY_STORAGE_METHOD:-}')
    expect(compose).toContain('MAKER_PRIVATE_KEY: ${MAKER_PRIVATE_KEY:-}')
    expect(compose).toContain('KEYSTORE_PATH: ${KEYSTORE_PATH:-}')
    expect(compose).toContain('KEYSTORE_PASSWORD: ${KEYSTORE_PASSWORD:-}')
    expect(compose).toContain('KEYSTORE_INTERACTIVE: ${KEYSTORE_INTERACTIVE:-}')
    expect(compose).toContain('AWS_KMS_KEY_ID: ${AWS_KMS_KEY_ID:-}')
    expect(compose).toContain('AWS_REGION: ${AWS_REGION:-}')
  })

  test('reads the started deployment ID and rejects output without one', () => {
    const raw = JSON.stringify({ deploymentId: 'created', logsUrl: 'https://railway.com/logs' })

    expect(parseStartedRailwayDeploymentId(raw)).toBe('created')
    expect(parseStartedRailwayDeploymentId(`Uploading...\n${raw}`)).toBe('created')
    expect(
      parseStartedRailwayDeploymentId('{"logsUrl":"https://railway.com/logs"}')
    ).toBeUndefined()
    expect(parseStartedRailwayDeploymentId('not-json')).toBeUndefined()
  })

  test("polls this run's deployment rather than whichever one Railway lists first", () => {
    const concurrent = JSON.stringify([
      { createdAt: '2026-09-15T12:00:01Z', id: 'someone-else', status: 'SUCCESS' },
      { createdAt: '2026-09-15T12:00:00Z', id: 'created', status: 'BUILDING' }
    ])

    expect(selectRailwayDeploymentById(concurrent, 'created')).toEqual({
      id: 'created',
      status: 'BUILDING'
    })
    expect(selectRailwayDeploymentById(concurrent, 'not-listed-yet')).toBeUndefined()
    expect(
      selectRailwayDeploymentById(
        JSON.stringify({ deployments: [{ id: 'a', status: 'QUEUED' }] }),
        'a'
      )
    ).toEqual({ id: 'a', status: 'QUEUED' })
    expect(selectRailwayDeploymentById('[{"id":"created"}]', 'created')).toBeUndefined()
    expect(selectRailwayDeploymentById('not-json', 'created')).toBeUndefined()
  })

  test('recognizes only handled terminal Railway statuses', () => {
    expect(isTerminalRailwayDeploymentStatus('SUCCESS')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('CRASHED')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('NEEDS_APPROVAL')).toBe(true)
    expect(isTerminalRailwayDeploymentStatus('DEPLOYING')).toBe(false)
    expect(isTerminalRailwayDeploymentStatus('UNKNOWN')).toBe(false)
  })
})

describe('per-chain Railway services', () => {
  test('names one service per supported chain', () => {
    expect(railwayServiceName(1)).toBe('quoter-bot-1')
    expect(railwayServiceName(8453)).toBe('quoter-bot-8453')
  })

  test('reports expected services Railway does not list, in expected order', () => {
    const existing = [
      { id: 'a', name: 'quoter-bot-8453' },
      { id: 'b', name: 'quoter-bot' }
    ]

    expect(missingRailwayServices(existing, ['quoter-bot-1', 'quoter-bot-8453'])).toEqual([
      'quoter-bot-1'
    ])
    expect(missingRailwayServices(existing, ['quoter-bot-8453'])).toEqual([])
    expect(missingRailwayServices([], ['quoter-bot-1', 'quoter-bot-8453'])).toEqual([
      'quoter-bot-1',
      'quoter-bot-8453'
    ])
  })

  test('deploy-only re-ships every supported chain and never provisions', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy-railway.ts', import.meta.url), 'utf8')
    const deployOnlyBranch = deploy.indexOf('if (DEPLOY_ONLY)')
    const fullProvisioningBranch = deploy.indexOf(
      'const service = railwayServiceName(chainIdValue(process.env))'
    )
    const deployOnlySource = deploy.slice(deployOnlyBranch, fullProvisioningBranch)

    expect(deployOnlySource).toContain('SUPPORTED_CHAIN_IDS.map(railwayServiceName)')
    expect(deployOnlySource).toContain('missingRailwayServices(await listServices(), services)')
    expect(deployOnlySource).not.toContain('ensureService(')
    expect(deployOnlySource).not.toContain('ensureStateVolume(')
    expect(deployOnlySource).not.toContain('setRuntimeVariable(')
    expect(deployOnlySource).toContain(
      'await reshipRailwayServices(services, startDeployment, waitForDeployment)'
    )
    expect(deployOnlySource).not.toContain('assertDeploymentSucceeded(')
  })

  test('one chain failing to start or report never blocks another chain re-ship', async () => {
    const events: string[] = []
    const statuses = await reshipRailwayServices(
      ['quoter-bot-1', 'quoter-bot-8453', 'quoter-bot-999'],
      async service => {
        events.push(`start ${service}`)
        if (service === 'quoter-bot-1') throw new Error('upload rejected')
        return `${service}-deployment`
      },
      async (service, deployment) => {
        events.push(`wait ${service} ${deployment}`)
        if (service === 'quoter-bot-999') throw new Error('status read failed')
        return 'SUCCESS'
      }
    )

    expect([...statuses]).toEqual([
      ['quoter-bot-1', 'START_FAILED'],
      ['quoter-bot-8453', 'SUCCESS'],
      ['quoter-bot-999', 'POLL_FAILED']
    ])
    // Every start is attempted before any wait begins.
    expect(events).toEqual([
      'start quoter-bot-1',
      'start quoter-bot-8453',
      'start quoter-bot-999',
      'wait quoter-bot-8453 quoter-bot-8453-deployment',
      'wait quoter-bot-999 quoter-bot-999-deployment'
    ])
    expect([...statuses.values()].every(status => status === 'SUCCESS')).toBe(false)
  })

  test('reports why a chain failed without repeating output that may carry CLI detail', async () => {
    const reasons = vi.spyOn(console, 'error').mockImplementation(() => {})
    await reshipRailwayServices(
      ['quoter-bot-1', 'quoter-bot-8453'],
      async service => {
        if (service === 'quoter-bot-1') {
          throw new RailwayDeploymentError('Railway accepted the upload but reported no ID')
        }

        throw new Error('railway up --project 0123 exited with stderr: token abc')
      },
      async () => 'SUCCESS'
    )
    const logged = reasons.mock.calls.flat().join('\n')
    reasons.mockRestore()

    expect(logged).toContain('[quoter-bot-1] Railway accepted the upload but reported no ID')
    expect(logged).toContain('[quoter-bot-8453] check this service in the Railway dashboard')
    expect(logged).not.toContain('token abc')
  })

  test('re-ship reports success only when every chain succeeds', async () => {
    const statuses = await reshipRailwayServices(
      ['quoter-bot-1', 'quoter-bot-8453'],
      async () => undefined,
      async () => 'SUCCESS'
    )

    expect([...statuses.values()].every(status => status === 'SUCCESS')).toBe(true)
  })
})
