import type { Client } from 'viem'

import { getAddress } from 'viem'
import { base } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import { assertContractDeployed, createDeploylessClient } from '../src/client'

const RPC = 'http://localhost:8545'
const ADDRESS = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')

// Minimal client whose eth_getCode returns `code` — enough to drive getCode without a network.
function stubClient(code: string): Client {
  return { request: async () => code } as unknown as Client
}

describe('createDeploylessClient', () => {
  it('wraps the RPC in viem-dlc deployless transport on the configured chain', () => {
    const client = createDeploylessClient({ chain: base, rpcUrl: RPC, rpcUrlFallback: undefined })
    expect(client.transport.type).toBe('viem-dlc-deployless')
    expect(client.chain?.id).toBe(base.id)
  })

  it('still presents a deployless transport when a fallback RPC is configured', () => {
    const client = createDeploylessClient({
      chain: base,
      rpcUrl: RPC,
      rpcUrlFallback: 'http://localhost:8546'
    })
    expect(client.transport.type).toBe('viem-dlc-deployless')
  })
})

describe('MAX_DEPLOYLESS_BATCH_SIZE', () => {
  const build = (value: string) =>
    createDeploylessClient({
      chain: base,
      rpcUrl: RPC,
      rpcUrlFallback: undefined,
      env: { MAX_DEPLOYLESS_BATCH_SIZE: value }
    })

  it.each(['100kb', '1e6', '-1', '0', '12.5', 'all'])(
    'rejects %s rather than chunking to a number it half-read',
    value => {
      // `parseInt` takes '100kb' as 100, which would silently chunk every lens read to 100 bytes.
      expect(() => build(value)).toThrow(/MAX_DEPLOYLESS_BATCH_SIZE/)
    }
  )

  it('rejects a value past 2^53, where Number would lose precision', () => {
    expect(() => build('9007199254740993')).toThrow(/safe integer/)
  })

  it('accepts a plain positive integer', () => {
    expect(() => build('2000000')).not.toThrow()
  })
})

describe('assertContractDeployed', () => {
  it('throws when the address holds no code', async () => {
    await expect(
      assertContractDeployed(stubClient('0x'), ADDRESS, 'EXECUTOOOR_ADDRESS')
    ).rejects.toThrow(/EXECUTOOOR_ADDRESS/)
  })

  it('resolves when the address holds code', async () => {
    await expect(
      assertContractDeployed(stubClient('0x6001600101'), ADDRESS, 'EXECUTOOOR_ADDRESS')
    ).resolves.toBeUndefined()
  })
})
