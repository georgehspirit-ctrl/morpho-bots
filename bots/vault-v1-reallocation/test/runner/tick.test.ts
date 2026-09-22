import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { getAddress, maxUint256 } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { TickDeps } from '../../src/runner/tick'
import type { VaultData } from '../../src/vault-data'

import { runTick } from '../../src/runner/tick'
import { makeMarket, makeVaultData, VAULT_CURATOR, VAULT_OWNER } from '../strategies/helpers'

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

const VAULT_A: Address = getAddress(`0x${'aa'.repeat(20)}`)
const VAULT_B: Address = getAddress(`0x${'bb'.repeat(20)}`)
const DATA = '0xdeadbeef' as const

const EOA: Address = getAddress(`0x${'ee'.repeat(20)}`)

const someVaultData = (): VaultData =>
  makeVaultData([makeMarket({ utilization: 0n, vaultAssets: 0n, cap: 0n })])

// The lens reads `isAllocator` into the snapshot, so "not an allocator" is a snapshot field now.
const notAnAllocator = (): VaultData => ({ ...someVaultData(), isAllocator: false })

const someAllocations = () => [
  {
    marketParams: {
      loanToken: VAULT_A,
      collateralToken: VAULT_B,
      oracle: VAULT_A,
      irm: VAULT_A,
      lltv: 0n
    },
    assets: maxUint256
  }
]

const makeDeps = (overrides: Partial<TickDeps> = {}) => {
  const { logger, events } = spyLogger()
  const deps: TickDeps = {
    vaults: [VAULT_A],
    chainHead: 100n,
    eoa: EOA,
    fetchVaults: vi.fn(
      async (vaults: readonly Address[]) =>
        new Map(vaults.map(vault => [vault.toLowerCase(), someVaultData()]))
    ),
    strategy: vi.fn(() => undefined),
    encodeReallocate: vi.fn(() => DATA),
    simulate: vi.fn(async () => ({ status: 'ok' as const })),
    submit: vi.fn(async () => ({ sent: true }) as const),
    dryRun: false,
    inflightLabels: () => new Set<string>(),
    revertReason: error => (error instanceof Error ? error.message : String(error)),
    logger,
    ...overrides
  }
  return { deps, events }
}

const tickEnd = (events: ReturnType<typeof spyLogger>['events']) =>
  events.find(e => e.event === 'tick.end')?.fields

describe('runTick', () => {
  it('submits a sim-ok reallocation and counts it', async () => {
    const { deps, events } = makeDeps({ strategy: vi.fn(() => someAllocations()) })
    await runTick(deps)
    expect(deps.submit).toHaveBeenCalledWith({ vault: VAULT_A, data: DATA })
    expect(tickEnd(events)).toMatchObject({ reallocations_found: 1, submitted: 1, errors: 0 })
    expect(events.some(e => e.event === 'reallocation.found')).toBe(true)
  })

  it('passes the tick chainHead into the vault fetch (block-pinned snapshot)', async () => {
    const { deps } = makeDeps({ chainHead: 123n })
    await runTick(deps)
    expect(deps.fetchVaults).toHaveBeenCalledWith([VAULT_A], 123n)
  })

  it('does nothing when the strategy finds no reallocation', async () => {
    const { deps, events } = makeDeps()
    await runTick(deps)
    expect(deps.simulate).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ reallocations_found: 0, submitted: 0 })
  })

  it('does not submit on a sim revert and logs the reason', async () => {
    const { deps, events } = makeDeps({
      strategy: vi.fn(() => someAllocations()),
      simulate: vi.fn(async () => ({ status: 'revert' as const, reason: 'CapExceeded' }))
    })
    await runTick(deps)
    expect(deps.submit).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      level: 'warn',
      event: 'reallocation.sim_revert',
      fields: { vault: VAULT_A, reason: 'CapExceeded' }
    })
    expect(tickEnd(events)).toMatchObject({ sim_reverts: 1, submitted: 0 })
  })

  it('logs instead of submitting in dry-run mode', async () => {
    const { deps, events } = makeDeps({ strategy: vi.fn(() => someAllocations()), dryRun: true })
    await runTick(deps)
    expect(deps.simulate).toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(events.some(e => e.event === 'reallocation.dry_run')).toBe(true)
    expect(tickEnd(events)).toMatchObject({ dry_runs: 1, submitted: 0 })
  })

  it('does not count a submit that was not broadcast', async () => {
    const { deps, events } = makeDeps({
      strategy: vi.fn(() => someAllocations()),
      submit: vi.fn(async () => ({ sent: false, reason: 'refused' }) as const)
    })
    await runTick(deps)
    expect(deps.submit).toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ reallocations_found: 1, submitted: 0 })
    expect(events).toContainEqual({
      level: 'debug',
      event: 'reallocation.not_broadcast',
      // The reason distinguishes a queue-wide refusal from this vault's own send being rejected.
      fields: { vault: VAULT_A, reason: 'refused' }
    })
  })

  it('skips a vault whose label is in flight', async () => {
    const { deps, events } = makeDeps({ inflightLabels: () => new Set([VAULT_A]) })
    await runTick(deps)
    expect(deps.fetchVaults).not.toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ skipped_inflight: 1 })
  })

  it('skips strategy/simulate while the allocator role is missing', async () => {
    const { deps, events } = makeDeps({
      fetchVaults: vi.fn(
        async (vaults: readonly Address[]) =>
          new Map(vaults.map(vault => [vault.toLowerCase(), notAnAllocator()]))
      )
    })
    await runTick(deps)
    expect(deps.strategy).not.toHaveBeenCalled()
    expect(deps.simulate).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      level: 'warn',
      event: 'allocator.missing_role',
      fields: { vault: VAULT_A }
    })
    expect(tickEnd(events)).toMatchObject({ missing_role: 1 })
  })

  it.each([
    ['owner', VAULT_OWNER],
    ['curator', VAULT_CURATOR]
  ])('accepts a %s-keyed EOA that is not in the allocator set', async (_role, eoa) => {
    const { deps, events } = makeDeps({
      eoa,
      fetchVaults: vi.fn(
        async (vaults: readonly Address[]) =>
          new Map(vaults.map(vault => [vault.toLowerCase(), notAnAllocator()]))
      ),
      strategy: vi.fn(() => someAllocations())
    })
    await runTick(deps)
    expect(deps.submit).toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ missing_role: 0, submitted: 1 })
  })

  it('reads every eligible vault in ONE call and still processes them concurrently', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const simulate = vi.fn(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      await Promise.resolve()
      inFlight--
      return { status: 'ok' as const }
    })
    const { deps, events } = makeDeps({
      vaults: [VAULT_A, VAULT_B],
      simulate,
      strategy: vi.fn(() => someAllocations())
    })
    await runTick(deps)
    // The read is batched — one request for the pass, not one per vault — but the per-vault work
    // after it still overlaps.
    expect(deps.fetchVaults).toHaveBeenCalledTimes(1)
    expect(deps.fetchVaults).toHaveBeenCalledWith([VAULT_A, VAULT_B], 100n)
    expect(maxInFlight).toBe(2)
    expect(tickEnd(events)).toMatchObject({ vaults: 2, reallocations_found: 2, submitted: 2 })
  })

  it('fans a rejected batch out over every eligible vault', async () => {
    // The read is the one shared point of failure now: a rejection yields no rows at all. Without an
    // explicit fan-out the pass would close reporting nothing, so an operator would see a quiet tick
    // rather than a whitelist-wide outage.
    const fetchVaults = vi.fn(async () => {
      throw new Error('rpc exploded')
    })
    const { deps, events } = makeDeps({ vaults: [VAULT_A, VAULT_B], fetchVaults })
    await runTick(deps)
    for (const vault of [VAULT_A, VAULT_B]) {
      expect(events).toContainEqual({
        level: 'error',
        event: 'vault.error',
        fields: { vault, reason: 'rpc exploded' }
      })
    }
    expect(tickEnd(events)).toMatchObject({ errors: 2, vaults: 2 })
  })

  it('does not pay for an in-flight vault, filtering before the batch is built', async () => {
    const { deps, events } = makeDeps({
      vaults: [VAULT_A, VAULT_B],
      inflightLabels: () => new Set([VAULT_A])
    })
    await runTick(deps)
    expect(deps.fetchVaults).toHaveBeenCalledWith([VAULT_B], 100n)
    expect(tickEnd(events)).toMatchObject({ skipped_inflight: 1 })
  })

  it('reads the in-flight label set once per pass', async () => {
    const inflightLabels = vi.fn(() => new Set<string>())
    const { deps } = makeDeps({ vaults: [VAULT_A, VAULT_B], inflightLabels })
    await runTick(deps)
    expect(inflightLabels).toHaveBeenCalledTimes(1)
  })

  it('continues past a vault the batch could not serve and reports vault.error', async () => {
    // A row missing from an otherwise-successful read: the envelope declined that element. The
    // others must still run.
    const fetchVaults = vi.fn(
      async (vaults: readonly Address[]) =>
        new Map(
          vaults.filter(v => v !== VAULT_A).map(vault => [vault.toLowerCase(), someVaultData()])
        )
    )
    const { deps, events } = makeDeps({ vaults: [VAULT_A, VAULT_B], fetchVaults })
    await runTick(deps)
    expect(fetchVaults).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({
      level: 'error',
      event: 'vault.error',
      fields: { vault: VAULT_A, reason: 'lens returned no row for this vault' }
    })
    expect(tickEnd(events)).toMatchObject({ errors: 1 })
  })
})
