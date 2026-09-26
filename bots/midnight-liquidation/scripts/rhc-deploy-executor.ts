/**
 * Deploys the Executor singleton to its deterministic CREATE2 address on Robinhood Chain.
 *
 * WHY THIS EXISTS AS A BOT SCRIPT. `packages/contracts/scripts/deploy-executor.ts` already does this,
 * but it sits outside this bot's esbuild `outbase`, so bundling it here would land the output at a
 * `../../packages/...` path. This is the same deployment, driven from the bot's own build.
 *
 * WHAT WENT WRONG WITHOUT IT. `EXECUTOOOR_ADDRESS` was pinned by hand to an address that, on 4663,
 * holds an unrelated contract — its dispatch table has no `exec_606BaXt` (selector 0x00000001), so
 * every liquidation call fell through to that contract's fallback and reverted with EMPTY data. The
 * config's only guard is that the address holds code, which it did; code presence is not identity.
 * Derive the address, never pin it.
 *
 * Idempotent: exits 0 if the deterministic address already holds code.
 */
import { Executor } from '@repo/contracts'
import { createPublicClient, createWalletClient, defineChain, http, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

function required(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) throw new Error(`Missing required env var: ${name}`)
  return value.trim()
}

const rpcUrl = required('RPC_URL')
const privateKey = required('DEPLOYER_PRIVATE_KEY')
if (!isHex(privateKey, { strict: true }) || privateKey.length !== 66) {
  throw new Error('DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
}

const { address, factory, factoryData } = Executor.with()
const account = privateKeyToAccount(privateKey)
const transport = http(rpcUrl)
const chainId = await createPublicClient({ transport }).getChainId()
const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }
})
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account, chain, transport })

console.log(`DERIVED_EXECUTOR=${address}`)
console.log(`factory=${factory}  chainId=${chainId}  deployer=${account.address}`)

const existing = await publicClient.getCode({ address })
if (existing && existing !== '0x') {
  console.log(`already deployed at ${address} (${(existing.length - 2) / 2} bytes) — nothing to do`)
  process.exit(0)
}

const factoryCode = await publicClient.getCode({ address: factory })
if (!factoryCode || factoryCode === '0x') {
  throw new Error(`canonical CREATE2 factory ${factory} is absent on chain ${chainId}`)
}

const hash = await walletClient.sendTransaction({ to: factory, data: factoryData })
const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') throw new Error(`deploy tx reverted (${hash})`)

// Confirmed receipt still races `getCode` on some RPCs; poll before declaring failure.
let deployed = await publicClient.getCode({ address })
for (let attempt = 0; (!deployed || deployed === '0x') && attempt < 5; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  deployed = await publicClient.getCode({ address })
}
if (!deployed || deployed === '0x') {
  throw new Error(`deploy tx ${hash} succeeded but no code at ${address} after retries`)
}
console.log(`EXECUTOR_DEPLOYED=${address} tx=${hash} bytes=${(deployed.length - 2) / 2}`)
