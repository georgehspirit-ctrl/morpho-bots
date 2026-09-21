/**
 * Reproducible Railway provisioning and deployment for the quoter-bot bot: one
 * `quoter-bot-<chainId>` service per supported chain, all inside one Railway project.
 *
 * A full run provisions the single chain named by `CHAIN_ID`: it creates that chain's service,
 * configures its package-owned Dockerfile and state volume, and uploads runtime variables through
 * stdin. Every input keeps its unsuffixed runtime name, so an operator runs it once per chain with
 * that chain's environment. CI sets DEPLOY_ONLY=true to re-ship every already-provisioned chain
 * service using only project-token deployment permissions; it creates nothing and names any chain
 * service that a full run has not yet provisioned. Both modes wait for each new deployment to reach
 * a terminal state and succeed only on Railway `SUCCESS`.
 */
import { delay, tryCatch } from '@repo/utils'
import { $ } from 'execa'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { addressValue, chainIdValue } from '../src/config/config.utils'
import { SUPPORTED_CHAIN_IDS } from '../src/config/supported-chains.utils'
import { requiresMaxRatificationGas } from '../src/config/write-policy.utils'
import { RailwayDeploymentError } from './railway-deployment.error'
import {
  assertFreshRailwayReferenceProvisioning,
  assertFullRailwaySignerProvisioning,
  isNonEmptyJsonArray,
  isTerminalRailwayDeploymentStatus,
  missingRailwayServices,
  parseRailwayServices,
  parseRailwayVolumes,
  parseStartedRailwayDeploymentId,
  railwayServiceName,
  reshipRailwayServices,
  selectRailwayDeploymentById,
  synchronizedOptionalRailwayVariables
} from './railway.utils'

const DEPLOYMENT_LIST_LIMIT = 20
const DOCKERFILE_PATH = 'bots/quoter-bot/Dockerfile'
const STATE_MOUNT_PATH = '/state'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT?.trim() || 'production'
const DEPLOY_ONLY = /^(1|true)$/i.test(process.env.DEPLOY_ONLY?.trim() || '')
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID?.trim()
if (!PROJECT_ID) {
  throw new RailwayDeploymentError('Missing required environment variable: RAILWAY_PROJECT_ID')
}

const requiredRuntimeVariableNames = [
  'CHAIN_ID',
  'RPC_URL',
  'MAKER_ADDRESS',
  'MIDNIGHT_ADDRESS',
  'LOAN_ASSET_ADDRESS',
  'RATIFIER_ADDRESS',
  'MORPHO_API_BASE_URL',
  'MARKET_IDS',
  'NATIVE_RESERVE_WEI',
  'MAX_FEE_GWEI',
  'PRIORITY_FEE_GWEI',
  'MAX_TRANSACTION_SPEND_WEI',
  'MAX_PUBLICATION_GAS',
  'MAX_PUBLICATION_DATA_BYTES',
  'MAX_CANCELLATION_GAS',
  'MAX_BATCH_CANCELLATION_GAS',
  'MAX_BATCH_CANCELLATION_DATA_BYTES',
  'BOOTSTRAP_MARKETS',
  'LADDER_MARKETS'
] as const

type RequiredRuntimeVariableName = (typeof requiredRuntimeVariableNames)[number]
type RuntimeVariable = readonly [name: string, value: string]

const required = (name: RequiredRuntimeVariableName) => {
  const value = process.env[name]?.trim()
  if (!value) throw new RailwayDeploymentError(`Missing required environment variable: ${name}`)
  if ((name === 'BOOTSTRAP_MARKETS' || name === 'LADDER_MARKETS') && !isNonEmptyJsonArray(value)) {
    throw new RailwayDeploymentError(`${name} must be a non-empty JSON array`)
  }

  return value
}

const runtimeVariables = (): RuntimeVariable[] => {
  const requiredVariables = requiredRuntimeVariableNames.map(
    name => [name, required(name)] as const
  )
  const optionalVariables = synchronizedOptionalRailwayVariables(process.env)
  const method =
    process.env.KEY_STORAGE_METHOD?.trim() ||
    (process.env.MAKER_PRIVATE_KEY?.trim() ? 'private-key' : '')
  if (!['private-key', 'keystore', 'aws'].includes(method)) {
    throw new RailwayDeploymentError('KEY_STORAGE_METHOD must select exactly one signer')
  }
  assertFullRailwaySignerProvisioning(method as 'private-key' | 'keystore' | 'aws')
  const signerValues: Record<string, string> = {
    KEY_STORAGE_METHOD: method,
    MAKER_PRIVATE_KEY: ' ',
    KEYSTORE_PATH: ' ',
    KEYSTORE_PASSWORD: ' ',
    KEYSTORE_INTERACTIVE: 'false',
    AWS_KMS_KEY_ID: ' ',
    AWS_REGION: ' ',
    SIGNER_NATIVE_RESERVE_WEI: ' ',
    MAX_RATIFICATION_GAS: ' '
  }
  const signerRequired =
    method === 'private-key'
      ? ['MAKER_PRIVATE_KEY']
      : method === 'keystore'
        ? ['KEYSTORE_PATH', 'KEYSTORE_PASSWORD']
        : ['AWS_KMS_KEY_ID', 'AWS_REGION', 'SIGNER_NATIVE_RESERVE_WEI']
  for (const name of signerRequired) {
    const value = process.env[name]?.trim()
    if (!value) throw new RailwayDeploymentError(`Missing required environment variable: ${name}`)
    signerValues[name] = value
  }
  const maxRatificationGas = process.env.MAX_RATIFICATION_GAS?.trim()
  if (
    requiresMaxRatificationGas(
      method as 'private-key' | 'keystore' | 'aws',
      addressValue(process.env, 'RATIFIER_ADDRESS'),
      chainIdValue(process.env)
    ) &&
    !maxRatificationGas
  ) {
    throw new RailwayDeploymentError('Missing required environment variable: MAX_RATIFICATION_GAS')
  }
  if (maxRatificationGas) signerValues.MAX_RATIFICATION_GAS = maxRatificationGas
  const signerVariables = Object.entries(signerValues) as RuntimeVariable[]

  return [...requiredVariables, ...signerVariables, ...optionalVariables]
}

const assertCli = async () => {
  const { error } = await tryCatch($`railway --version`)
  if (error) throw new RailwayDeploymentError('Railway CLI is unavailable')
}

const ensureContext = async () => {
  if (process.env.RAILWAY_TOKEN) return

  const { error } = await tryCatch(
    $`railway link --project ${PROJECT_ID} --environment ${ENVIRONMENT} --json`
  )
  if (error) throw new RailwayDeploymentError('Failed to select the Railway project environment')
}

const linkServiceContext = async (serviceId: string) => {
  const { error } = await tryCatch($`railway service link ${serviceId}`)
  if (error) throw new RailwayDeploymentError('Failed to select the Railway service')
}

const listServices = async () => {
  const { data, error } = await tryCatch(
    $`railway service list --project ${PROJECT_ID} --environment ${ENVIRONMENT} --json`.then(
      result => result.stdout
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to list Railway services')
  }

  return parseRailwayServices(data)
}

const ensureService = async (service: string) => {
  const services = await listServices()
  const existingService = services.find(candidate => candidate.name === service)
  if (existingService) return { service: existingService, isFreshService: false }

  assertFreshRailwayReferenceProvisioning(process.env, true)
  const { data, error } = await tryCatch(
    $`railway add --service ${service} --json`.then(result => result.stdout)
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to create the Railway service')
  }

  const createdService = parseRailwayServices(data).find(candidate => candidate.name === service)
  if (!createdService) {
    throw new RailwayDeploymentError('Railway service creation returned incomplete identity')
  }

  return { service: createdService, isFreshService: true }
}

const listVolumes = async () => {
  const { data, error } = await tryCatch(
    $`railway volume list --json`.then(result => result.stdout)
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to list Railway volumes')
  }

  return parseRailwayVolumes(data)
}

const configuredStateVolume = async (service: string) => {
  const volumes = (await listVolumes()).filter(candidate => candidate.serviceName === service)
  if (volumes.length > 1) {
    throw new RailwayDeploymentError('Railway service has multiple attached volumes')
  }

  const volume = volumes[0]
  if (!volume) return undefined
  if (volume.isPendingDeletion) {
    throw new RailwayDeploymentError('Railway state volume is pending deletion')
  }
  if (volume.mountPath !== STATE_MOUNT_PATH) {
    throw new RailwayDeploymentError('Railway state volume uses an unexpected mount path')
  }

  return volume
}

const ensureStateVolume = async (service: string) => {
  if (await configuredStateVolume(service)) return

  const { error } = await tryCatch($`railway volume add --mount-path ${STATE_MOUNT_PATH} --json`)
  if (error) throw new RailwayDeploymentError('Failed to create the Railway state volume')

  for (let attempt = 1; attempt <= 10; attempt++) {
    if (await configuredStateVolume(service)) return
    if (attempt < 10) await delay(1_000)
  }

  throw new RailwayDeploymentError('Railway state volume confirmation timed out')
}

const setRuntimeVariable = async (service: string, [name, value]: RuntimeVariable) => {
  const { error } = await tryCatch(
    $({
      input: value
    })`railway variable set ${name} --stdin --service ${service} --environment ${ENVIRONMENT} --skip-deploys`
  )
  if (error) throw new RailwayDeploymentError(`Failed to set Railway variable: ${name}`)

  console.log(`[${service}] configured ${name}`)
}

const deploymentListJson = async (service: string) => {
  const { data, error } = await tryCatch(
    $`railway deployment list --service ${service} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --limit ${DEPLOYMENT_LIST_LIMIT} --json`.then(
      result => result.stdout
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to read Railway deployment status')
  }

  return data
}

const startDeployment = async (service: string) => {
  const message = `${service}-${ENVIRONMENT}`
  const { data, error } = await tryCatch(
    $({
      cwd: REPO_ROOT
    })`railway up --service ${service} --project ${PROJECT_ID} --environment ${ENVIRONMENT} --detach --json --message ${message}`.then(
      result => result.stdout
    )
  )
  if (error || typeof data !== 'string') {
    throw new RailwayDeploymentError('Failed to start the Railway deployment')
  }

  const deploymentId = parseStartedRailwayDeploymentId(data)
  if (!deploymentId) {
    throw new RailwayDeploymentError(
      'Railway accepted the upload but reported no deployment ID, so it may still be in flight. ' +
        'Check that the Railway CLI supports `up --detach --json`.'
    )
  }

  console.log(`[${service}] deployment ${deploymentId} started`)

  return deploymentId
}

const waitForDeployment = async (
  service: string,
  deploymentId: string,
  maxAttempts = 60,
  intervalMs = 10_000
) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deployment = selectRailwayDeploymentById(await deploymentListJson(service), deploymentId)
    if (deployment && isTerminalRailwayDeploymentStatus(deployment.status)) {
      return deployment.status
    }

    console.log(
      `[${service}] deployment ${deploymentId} ${deployment?.status ?? 'unlisted'} (${attempt}/${maxAttempts})`
    )
    if (attempt < maxAttempts) await delay(intervalMs)
  }

  return 'TIMEOUT'
}

const assertDeploymentSucceeded = (service: string, status: string) => {
  if (status !== 'SUCCESS') {
    throw new RailwayDeploymentError(`Railway deployment ended with status: ${status}`)
  }

  console.log(`${service} deployment succeeded`)
}

const configuredRuntimeVariables = DEPLOY_ONLY ? [] : runtimeVariables()

await assertCli()
await ensureContext()

if (DEPLOY_ONLY) {
  const services = SUPPORTED_CHAIN_IDS.map(railwayServiceName)
  const missing = missingRailwayServices(await listServices(), services)
  if (missing.length > 0) {
    throw new RailwayDeploymentError(
      `DEPLOY_ONLY cannot create services. Not provisioned in ${ENVIRONMENT}: ${missing.join(', ')}. ` +
        'Run a full deploy of this script with that CHAIN_ID first.'
    )
  }

  const statuses = await reshipRailwayServices(services, startDeployment, waitForDeployment)

  console.log('')
  console.log('=== Deploy-only status ===')
  for (const [service, status] of statuses) console.log(`  ${service}: ${status}`)
  process.exit([...statuses.values()].every(status => status === 'SUCCESS') ? 0 : 1)
}

const service = railwayServiceName(chainIdValue(process.env))
const { service: railwayService } = await ensureService(service)

await linkServiceContext(railwayService.id)
await setRuntimeVariable(service, ['RAILWAY_RUN_UID', '0'])
await setRuntimeVariable(service, ['RAILWAY_DOCKERFILE_PATH', DOCKERFILE_PATH])
await setRuntimeVariable(service, ['XDG_STATE_HOME', STATE_MOUNT_PATH])
for (const variable of configuredRuntimeVariables) await setRuntimeVariable(service, variable)
await ensureStateVolume(service)

const deploymentId = await startDeployment(service)
assertDeploymentSucceeded(service, await waitForDeployment(service, deploymentId))
