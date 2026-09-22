import type { Client, Transport } from 'viem'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BatchLensTransportType } from '../../src/helpers/deployless-batch-lens'

const readContractMock = vi.hoisted(() => vi.fn())
const policySpy = vi.hoisted(() => vi.fn())

vi.mock('viem/actions', async importOriginal => {
  const actual = await importOriginal<typeof import('viem/actions')>()
  return { ...actual, readContract: (...args: unknown[]) => readContractMock(...args) }
})

vi.mock('@morpho-org/viem-dlc', async importOriginal => {
  const actual = await importOriginal<typeof import('@morpho-org/viem-dlc')>()
  return {
    ...actual,
    policy: (options: Parameters<typeof actual.policy>[0]) => {
      policySpy(options)
      return actual.policy(options)
    }
  }
})

const { readDeploylessBatchLens } = await import('../../src/helpers/deployless-batch-lens')

const abi = [
  {
    type: 'function',
    name: 'priceOf',
    stateMutability: 'view',
    inputs: [{ name: 'oracle', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const

const CLIENT = { chain: { id: 8453 } } as unknown as Client<Transport<BatchLensTransportType>>
const ORACLES = ['0x01', '0x02', '0x03', '0x04'] as const

/** `[results, skipped]`, the arrayified fragment's two outputs. */
function page(results: bigint[], skipped: number[]) {
  readContractMock.mockResolvedValueOnce([results, skipped.map(BigInt)])
}

function read(declined?: 'omit' | 'throw') {
  return readDeploylessBatchLens({
    client: CLIENT,
    parameters: {
      abi,
      address: '0x00000000000000000000000000000000000000aa',
      factory: '0x00000000000000000000000000000000000000bb',
      factoryData: '0x',
      functionName: 'priceOf',
      args: ORACLES,
      ...(declined === undefined ? {} : { declined })
    },
    key: oracle => oracle,
    value: (_oracle, price) => price
  })
}

describe('readDeploylessBatchLens', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pairs a dense page with the inputs in order', async () => {
    page([10n, 20n, 30n, 40n], [])
    await expect(read()).resolves.toEqual(
      new Map([
        ['0x01', 10n],
        ['0x02', 20n],
        ['0x03', 30n],
        ['0x04', 40n]
      ])
    )
  })

  it('realigns results around declined elements rather than by input position', async () => {
    // `results` is dense: two entries for the two elements the envelope served, so pairing them
    // with `args[0]`/`args[1]` — the bug this guards — would mislabel both.
    page([20n, 40n], [0, 2])
    await expect(read('omit')).resolves.toEqual(
      new Map([
        ['0x02', 20n],
        ['0x04', 40n]
      ])
    )
  })

  it('throws by default rather than returning a sparse map', async () => {
    page([20n, 30n, 40n], [0])
    await expect(read()).rejects.toThrow(/declined 1\/4 elements/)
  })

  it('rejects a page carrying the wrong number of results', async () => {
    page([20n], [0])
    await expect(read('omit')).rejects.toThrow(/results for 3 served elements/)
  })

  // The delivery and compression defaults are the reader's, not a callsite's and not viem-dlc's.
  // Asserting them here is what fails if either is dropped; the api-proxy fixture answers both
  // deliveries by design, so it cannot notice.
  it('asks for state-override delivery with compression off', async () => {
    page([10n, 20n, 30n, 40n], [])
    await read()
    expect(policySpy).toHaveBeenCalledTimes(1)
    expect(policySpy.mock.calls[0]![0].batch).toMatchObject({
      compress: false,
      envelope: 'override'
    })
  })

  it('short-circuits an empty input without calling the chain', async () => {
    await expect(
      readDeploylessBatchLens({
        client: CLIENT,
        parameters: {
          abi,
          address: '0x00000000000000000000000000000000000000aa',
          factory: '0x00000000000000000000000000000000000000bb',
          factoryData: '0x',
          functionName: 'priceOf',
          args: []
        },
        key: (oracle: string) => oracle,
        value: (_oracle, price) => price
      })
    ).resolves.toEqual(new Map())
    expect(readContractMock).not.toHaveBeenCalled()
  })
})
