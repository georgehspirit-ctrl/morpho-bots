import { tryCatch } from '@repo/utils'

import { RailwayDeploymentError } from './railway-deployment.error'

type RailwayDeployment = {
  id: string
  status: string
}

type RailwayService = {
  id: string
  name: string
}

type RailwayVolume = {
  id: string
  isPendingDeletion: boolean
  mountPath: string
  serviceName: string
}

const optionalRuntimeVariableDefaults = [
  ['REFERENCE_RPC_URL', ' '],
  ['REFERENCE_MARKET_ID', ' '],
  ['REFERENCE_LOOKBACK_SECONDS', ' '],
  ['V0_OFFER_GROUP_IDS', ' '],
  ['REQUEST_TIMEOUT_MS', '10000'],
  ['TRANSACTION_RECEIPT_TIMEOUT_MS', '180000'],
  ['BETTERSTACK_SOURCE_TOKEN', ' '],
  ['BETTERSTACK_INGESTING_HOST', ' '],
  ['BETTERSTACK_HEARTBEAT_URL', ' ']
] as const

const referenceVariableNames = new Set([
  'REFERENCE_RPC_URL',
  'REFERENCE_MARKET_ID',
  'REFERENCE_LOOKBACK_SECONDS'
])

type OptionalRuntimeVariableName = (typeof optionalRuntimeVariableDefaults)[number][0]
type OptionalRuntimeVariable = readonly [name: OptionalRuntimeVariableName, value: string]

const terminalStatuses = new Set([
  'SUCCESS',
  'FAILED',
  'CRASHED',
  'NEEDS_APPROVAL',
  'SLEEPING',
  'SKIPPED',
  'REMOVED',
  'REMOVING'
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringField = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * Rejects full Railway provisioning for signer modes whose credentials or files cannot be seeded.
 * @param method - Validated signer method selected by the invoking environment.
 * @throws `RailwayDeploymentError` for keystore or AWS KMS full
 * provisioning.
 * @remarks Existing services may use those modes only after out-of-band provisioning followed by
 * `DEPLOY_ONLY=true`; this guard performs no Railway or filesystem side effects.
 */
export const assertFullRailwaySignerProvisioning = (method: 'private-key' | 'keystore' | 'aws') => {
  if (method === 'keystore') {
    throw new RailwayDeploymentError(
      'Keystore Railway deployment requires a pre-provisioned file; use DEPLOY_ONLY=true'
    )
  }
  if (method === 'aws') {
    throw new RailwayDeploymentError(
      'AWS KMS Railway deployment requires pre-provisioned credentials; use DEPLOY_ONLY=true'
    )
  }
}

const rowsFrom = (value: unknown, key: 'deployments' | 'services' | 'volumes') => {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []

  const rows = value[key]
  return Array.isArray(rows) ? rows : []
}

/**
 * Checks whether a deployment strategy value is a populated JSON array.
 * @param raw - Candidate environment value before runtime configuration parsing.
 * @returns `true` only when the value is valid JSON whose root array contains at least one entry.
 * @remarks Entry-level validation remains the responsibility of the runtime configuration loader.
 */
export const isNonEmptyJsonArray = (raw: string) => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)

  return Array.isArray(data) && data.length > 0
}

const everyConfiguredWorkflowUsesHardcodedRate = (
  environment: Readonly<Record<string, string | undefined>>
) =>
  ['BOOTSTRAP_MARKETS', 'LADDER_MARKETS'].every(name => {
    const { data } = tryCatch(() => JSON.parse(environment[name] ?? '') as unknown)
    return (
      Array.isArray(data) &&
      data.length > 0 &&
      data.every(
        item =>
          isRecord(item) && isRecord(item.targetRate) && item.targetRate.strategy === 'hardcoded'
      )
    )
  })

/**
 * Rejects fresh Railway services that would start a variable-rate workflow without Blue references.
 * @param environment - Invoking environment containing strategy and optional reference variables.
 * @param isFreshService - Whether this provisioning run created the Railway service.
 * @throws `RailwayDeploymentError` when a fresh variable-rate service lacks either Blue reference.
 * @remarks Existing services preserve omitted Railway reference variables; hardcoded-only services do
 * not require Blue configuration.
 */
export const assertFreshRailwayReferenceProvisioning = (
  environment: Readonly<Record<string, string | undefined>>,
  isFreshService: boolean
) => {
  if (!isFreshService || everyConfiguredWorkflowUsesHardcodedRate(environment)) return

  for (const name of ['REFERENCE_RPC_URL', 'REFERENCE_MARKET_ID'] as const) {
    if (!environment[name]?.trim()) {
      throw new RailwayDeploymentError(`Missing required environment variable: ${name}`)
    }
  }
}

/**
 * Produces optional Railway configuration for a full operator deployment.
 * @param environment - Invoking environment whose non-blank values override safe defaults.
 * @returns Optional variables with timeouts reset to runtime defaults. Missing reference variables
 * are cleared only when every configured workflow uses a hardcoded target rate; otherwise they are
 * omitted so a full deployment preserves any existing Railway Blue configuration.
 * @remarks Railway CLI 5.30.4 rejects empty stdin values. The bot trims whitespace sentinels to an
 * unset value, allowing full runs to clear stale inactive configuration without triggering
 * intermediate deployments.
 */
export const synchronizedOptionalRailwayVariables = (
  environment: Readonly<Record<string, string | undefined>>
): OptionalRuntimeVariable[] =>
  optionalRuntimeVariableDefaults.flatMap(([name, defaultValue]) => {
    const configuredValue = environment[name]?.trim()
    if (
      referenceVariableNames.has(name) &&
      !configuredValue &&
      !everyConfiguredWorkflowUsesHardcodedRate(environment)
    ) {
      return []
    }

    return [[name, configuredValue || defaultValue]]
  })

/**
 * Names the Railway service that runs one chain; every supported chain gets its own service.
 * @param chainId - Supported EVM chain identifier the service is provisioned for.
 * @returns The project-wide service name, `quoter-bot-<chainId>`.
 */
export const railwayServiceName = (chainId: number) => `quoter-bot-${chainId}`

/**
 * Lists expected services that Railway does not report.
 * @param existing - Services returned by `railway service list`.
 * @param expected - Service names a deploy-only run must be able to re-ship.
 * @returns Expected names absent from `existing`, in `expected` order.
 * @remarks Deploy-only runs hold no secrets and so cannot create a service; naming the missing ones
 * up front turns an opaque `railway up` failure into an instruction to run a full deploy.
 */
export const missingRailwayServices = (
  existing: readonly RailwayService[],
  expected: readonly string[]
) => {
  const names = new Set(existing.map(service => service.name))
  return expected.filter(name => !names.has(name))
}

const operatorSafeReason = (error: unknown) =>
  error instanceof RailwayDeploymentError
    ? error.message
    : 'check this service in the Railway dashboard before retrying'

/**
 * Re-ships already-provisioned services: starts every upload first, then waits on each.
 * @param services - Service names to redeploy, in reporting order.
 * @param start - Starts one service's upload and returns the handle its wait polls.
 * @param wait - Resolves one started service to its terminal Railway status.
 * @returns Every service's terminal status, in `services` order; `START_FAILED` when its upload
 * could not be started or confirmed and `POLL_FAILED` when its status could not be read.
 * @remarks One chain's failure never blocks another's re-ship: a rejected start is recorded and the
 * remaining services still start, and no wait begins until every start has been attempted. A status
 * word cannot say whether a failed start left a deployment running, so each rejection also logs its
 * {@link RailwayDeploymentError} message; any other rejection logs a fixed line instead of its own,
 * which may carry CLI output.
 */
export const reshipRailwayServices = async <Started>(
  services: readonly string[],
  start: (service: string) => Promise<Started>,
  wait: (service: string, started: Started) => Promise<string>
) => {
  const started = new Map<string, Started>()
  const statuses = new Map<string, string>()
  for (const service of services) {
    const { data, error } = await tryCatch(start(service))
    if (error) {
      statuses.set(service, 'START_FAILED')
      console.error(`[${service}] ${operatorSafeReason(error)}`)
    } else started.set(service, data)
  }
  for (const [service, handle] of started) {
    const { data, error } = await tryCatch(wait(service, handle))
    if (error) console.error(`[${service}] ${operatorSafeReason(error)}`)
    statuses.set(service, error ? 'POLL_FAILED' : data)
  }

  return new Map(services.map(service => [service, statuses.get(service) ?? 'POLL_FAILED']))
}

/**
 * Parses Railway service JSON without exposing unknown response fields.
 * @param raw - Complete JSON emitted by `railway service list --json` or `railway add --json`.
 * @returns Identified, named services in response order; malformed or incomplete rows are omitted.
 */
export const parseRailwayServices = (raw: string): RailwayService[] => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = isRecord(data) && stringField(data.id) ? [data] : rowsFrom(data, 'services')

  return rows
    .filter(isRecord)
    .map(row => ({
      id: stringField(row.id),
      name: stringField(row.name) || stringField(row.serviceName)
    }))
    .filter(service => service.id.length > 0 && service.name.length > 0)
}

/**
 * Parses attached Railway volume identity and mount metadata from CLI JSON.
 * @param raw - Complete JSON emitted by `railway volume list --json`.
 * @returns Complete attached volumes in response order; malformed or detached rows are omitted.
 */
export const parseRailwayVolumes = (raw: string): RailwayVolume[] => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const rows = rowsFrom(data, 'volumes')

  return rows.filter(isRecord).flatMap(row => {
    const id = stringField(row.id)
    const mountPath = stringField(row.mountPath)
    const serviceName = stringField(row.serviceName)
    if (!id || !mountPath || !serviceName || typeof row.isPendingDeletion !== 'boolean') return []

    return [
      {
        id,
        isPendingDeletion: row.isPendingDeletion,
        mountPath,
        serviceName
      }
    ]
  })
}

/**
 * Reads the id Railway assigns to the upload started by `railway up --detach --json`.
 * @param raw - Complete stdout emitted by `railway up --detach --json`.
 * @returns The started deployment's ID, or `undefined` for malformed output.
 */
export const parseStartedRailwayDeploymentId = (raw: string): string | undefined => {
  for (const line of raw.split('\n')) {
    const { data } = tryCatch(() => JSON.parse(line) as unknown)
    const id = isRecord(data) ? stringField(data.deploymentId) : ''
    if (id) return id
  }

  return undefined
}

/**
 * Selects one Railway deployment by ID, so a deployment started concurrently on the same service
 * is never mistaken for the caller's.
 * @param raw - Complete JSON emitted by `railway deployment list --json`.
 * @param deploymentId - ID `railway up --detach --json` reported for this run's upload.
 * @returns That deployment, or `undefined` until Railway lists it with a status.
 */
export const selectRailwayDeploymentById = (
  raw: string,
  deploymentId: string
): RailwayDeployment | undefined => {
  const { data } = tryCatch(() => JSON.parse(raw) as unknown)
  const row = rowsFrom(data, 'deployments')
    .filter(isRecord)
    .find(candidate => stringField(candidate.id) === deploymentId)
  const status = row ? stringField(row.status) : ''

  return status ? { id: deploymentId, status } : undefined
}

/**
 * Identifies lifecycle states after which Railway will make no further deployment progress.
 * @param status - Deployment status returned by Railway.
 * @returns `true` only for Railway terminal statuses handled by the deploy script.
 */
export const isTerminalRailwayDeploymentStatus = (status: string) => terminalStatuses.has(status)
