import type { Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { isAddressEqual } from 'viem'

import type { Reallocation, ReallocationAction, Strategy } from '../strategies'
import type { VaultV2Data, VaultV2Result } from '../vault-data'

export type TickDeps = {
  vaults: Address[]
  chainHead: bigint
  /**
   * The adapter the signing policy was pinned to at startup. A curator swapping the adapter
   * mid-run would otherwise surface as an opaque PolicyViolationError on every submit — the tick
   * skips the vault with an actionable `adapter.changed` instead (restart to re-pin).
   */
  expectedAdapter: (vault: Address) => Address | undefined
  /**
   * One deployless read covering every eligible vault. Keyed by lower-cased vault address; each
   * entry is either that vault's snapshot or the reason it alone is unusable.
   */
  fetchVaults: (
    vaults: readonly Address[],
    blockNumber: bigint
  ) => Promise<Map<string, VaultV2Result>>
  strategy: Strategy
  encodeReallocation: (vaultData: VaultV2Data, reallocation: Reallocation) => Hex
  simulate: (vault: Address, data: Hex) => Promise<SimulateResult>
  /** Resolves true only when the transaction was actually broadcast. */
  submit: (params: { vault: Address; data: Hex }) => Promise<SubmitOutcome>
  /** When true, a sim-ok plan is logged (`reallocation.dry_run`) instead of submitted. */
  dryRun: boolean
  /** Labels (vault addresses) with an in-flight or cooling-down tx — skipped this tick. */
  inflightLabels: () => ReadonlySet<string>
  revertReason: (error: unknown) => string
  logger: Logger
}

type VaultCounters = {
  skipped_inflight: number
  missing_role: number
  adapter_changed: number
  reallocations_found: number
  sim_reverts: number
  dry_runs: number
  submitted: number
  errors: number
}

const NO_COUNTS: VaultCounters = {
  skipped_inflight: 0,
  missing_role: 0,
  adapter_changed: 0,
  reallocations_found: 0,
  sim_reverts: 0,
  dry_runs: 0,
  submitted: 0,
  errors: 0
}

const COUNTER_KEYS = Object.keys(NO_COUNTS) as (keyof VaultCounters)[]

const legSummary = (action: 'allocate' | 'deallocate', leg: ReallocationAction) => ({
  action,
  marketId: leg.marketId,
  collateralToken: leg.marketParams.collateralToken,
  lltv: leg.marketParams.lltv,
  assets: leg.assets
})

const summarize = (reallocation: Reallocation) => [
  ...reallocation.deallocations.map(leg => legSummary('deallocate', leg)),
  ...reallocation.allocations.map(leg => legSummary('allocate', leg))
]

const processVault = async (
  deps: TickDeps,
  vault: Address,
  vaultData: VaultV2Data
): Promise<VaultCounters> => {
  // Strict `isAllocator(eoa)`, read in the snapshot's single call (see {@link VaultV2Data}); a
  // vault the EOA cannot reallocate is skipped, and resumes on its own once the role is granted.
  if (!vaultData.isAllocator) {
    deps.logger.warn('allocator.missing_role', { vault })
    return { ...NO_COUNTS, missing_role: 1 }
  }

  const expectedAdapter = deps.expectedAdapter(vault)
  if (expectedAdapter !== undefined && !isAddressEqual(vaultData.adapterAddress, expectedAdapter)) {
    deps.logger.warn('adapter.changed', {
      vault,
      expected: expectedAdapter,
      actual: vaultData.adapterAddress,
      detail: 'restart the bot to re-pin the signing policy to the new adapter'
    })
    return { ...NO_COUNTS, adapter_changed: 1 }
  }

  // Surfaced because `apy-range` excludes these outright — the curve inversion it relies on needs a
  // real AdaptiveCurveIRM `rateAtTarget` (`equalize-utilizations` keeps them).
  if (vaultData.nonAdaptiveCurveMarketIds.length > 0) {
    deps.logger.debug('market.non_adaptive_curve', {
      vault,
      markets: vaultData.nonAdaptiveCurveMarketIds
    })
  }

  const reallocation = deps.strategy(vaultData)
  if (!reallocation) return NO_COUNTS

  const summary = summarize(reallocation)
  deps.logger.info('reallocation.found', { vault, legs: summary.length, allocations: summary })

  const data = deps.encodeReallocation(vaultData, reallocation)
  const sim = await deps.simulate(vault, data)
  if (sim.status === 'revert') {
    deps.logger.warn('reallocation.sim_revert', { vault, reason: sim.reason })
    return { ...NO_COUNTS, reallocations_found: 1, sim_reverts: 1 }
  }

  if (deps.dryRun) {
    // The plan itself was just logged by reallocation.found — this line only marks the decision.
    deps.logger.info('reallocation.dry_run', { vault })
    return { ...NO_COUNTS, reallocations_found: 1, dry_runs: 1 }
  }

  const outcome = await deps.submit({ vault, data })
  if (!outcome.sent) {
    deps.logger.debug('reallocation.not_broadcast', { vault, reason: outcome.reason })
  }
  return { ...NO_COUNTS, reallocations_found: 1, submitted: outcome.sent ? 1 : 0 }
}

/**
 * One reallocation pass: in-flight vaults are dropped, the rest are read in ONE block-pinned
 * deployless call (allocator bit included), then processed concurrently — skip (loudly) if the EOA
 * lacks the role or the vault's adapter changed since startup, run the strategy, simulate the exact
 * multicall bytes, and submit (or dry-run-log) on sim-ok. A failure in one vault logs `vault.error`
 * and never blocks the others; counters are folded after every vault settles and closed by one wide
 * `tick.end` line.
 *
 * The read is batched, so unlike the per-vault work it is a single point of failure: a rejected
 * request costs every vault this pass rather than one, and the interval gate means the retry is the
 * next reallocation interval rather than the next block. That is the trade for N-1 fewer round trips
 * and N-1 fewer deployless deploys; the failure is fanned out below so the counters and `vault.error`
 * lines still read per vault.
 */
export const runTick = async (deps: TickDeps): Promise<void> => {
  const started = Date.now()
  const inflight = deps.inflightLabels()

  // Filtered BEFORE the read, not per vault after it: an in-flight vault should not be paid for.
  const eligible = deps.vaults.filter(vault => {
    if (!inflight.has(vault)) return true
    deps.logger.debug('vault.inflight', { vault })
    return false
  })
  const skippedInflight = deps.vaults.length - eligible.length

  const snapshot = await tryCatch(
    eligible.length === 0
      ? Promise.resolve(new Map<string, VaultV2Result>())
      : deps.fetchVaults(eligible, deps.chainHead)
  )
  if (snapshot.error) {
    // One rejection yields no rows at all, so the per-vault lines have to be emitted explicitly or
    // the tick would close having silently done nothing for the whole whitelist.
    const reason = deps.revertReason(snapshot.error)
    for (const vault of eligible) deps.logger.error('vault.error', { vault, reason })
    deps.logger.info('tick.end', {
      blockNumber: deps.chainHead,
      vaults: deps.vaults.length,
      ...NO_COUNTS,
      skipped_inflight: skippedInflight,
      errors: eligible.length,
      duration_ms: Date.now() - started
    })
    return
  }

  // The mapper cannot reject — `processVault` is wrapped in `tryCatch` and every branch returns a
  // counter set — so `Promise.all` never short-circuits a vault.
  const results = await Promise.all(
    eligible.map(async (vault): Promise<VaultCounters> => {
      const result = snapshot.data.get(vault.toLowerCase())
      if (!result) {
        deps.logger.error('vault.error', { vault, reason: 'lens returned no row for this vault' })
        return { ...NO_COUNTS, errors: 1 }
      }
      if (result.error) {
        deps.logger.error('vault.error', { vault, reason: deps.revertReason(result.error) })
        return { ...NO_COUNTS, errors: 1 }
      }
      const { data, error } = await tryCatch(processVault(deps, vault, result.data))
      if (error) {
        deps.logger.error('vault.error', { vault, reason: deps.revertReason(error) })
        return { ...NO_COUNTS, errors: 1 }
      }
      return data
    })
  )

  const counters = results.reduce<VaultCounters>(
    (acc, result) => {
      for (const key of COUNTER_KEYS) acc[key] += result[key]
      return acc
    },
    { ...NO_COUNTS }
  )
  counters.skipped_inflight += skippedInflight

  deps.logger.info('tick.end', {
    blockNumber: deps.chainHead,
    vaults: deps.vaults.length,
    ...counters,
    duration_ms: Date.now() - started
  })
}
