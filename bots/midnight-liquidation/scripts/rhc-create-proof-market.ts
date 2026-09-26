/**
 * Creates one short-maturity Midnight market on Robinhood Chain to prove the liquidator end to end.
 *
 * Shape is deliberate: USDG is BOTH the loan token and the only collateral, priced by the identity
 * oracle at exactly ORACLE_PRICE_SCALE (verified on chain: 1e36). Three things follow, and together
 * they make this the only honest way to prove the maturity path quickly.
 *
 *  - Health is time-invariant. The oracle cannot move, debt does not accrue, and `take` refuses to
 *    mint an unhealthy seller — so no price drawdown can make the position liquidatable. MATURITY IS
 *    THE ONLY TRIGGER, which is precisely the behaviour under test.
 *  - Liquidation is swap-free. The seized collateral already IS the loan token, so the Executor needs
 *    no venue, no route and no aggregator key. A failure therefore indicts our liquidator rather than
 *    Rialto or LiFi.
 *  - At 98% LLTV the incentive is thin (maxLif ≈ 1.006, ~60bps), so this also exercises the tightest
 *    profitability path we have rather than an easy one.
 *
 * Runs on Railway, never locally. Simulates before broadcasting and refuses to send if the
 * simulation reverts. Market params are IMMUTABLE once created — there is no edit, only another
 * market — so everything here is explicit rather than derived at runtime.
 */
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, getAddress, http, keccak256, concat, zeroAddress, zeroHash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const CHAIN_ID = 4663
const MIDNIGHT = getAddress('0x6120765Ba5336150BbdDdD0Cd9108B5bFD369632')
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
/** Identity oracle: price() returns exactly 1e36, so USDG is worth exactly USDG. */
const IDENTITY_ORACLE = getAddress('0xf822Fa27EB9DFD53E49da8cc7fCFE84247641460')
const LLTV_98 = 980_000_000_000_000_000n
const CURSOR = 300_000_000_000_000_000n // the only cursor enabled on this deployment
const RCF_THRESHOLD = 100_000_000n // $100, USDG 6dp

/** Minutes until maturity. Needs > 10 for the seed's own MIN_SECONDS_TO_MATURITY guard, and enough
 *  runway for the 60-minute post-maturity incentive ramp to reach a profitable level. */
const MATURITY_MINUTES = Number(process.env.PROOF_MATURITY_MINUTES ?? 75)

const robinhood = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'] } }
})

const MARKET_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'chainId', type: 'uint256' },
    { name: 'midnight', type: 'address' },
    { name: 'loanToken', type: 'address' },
    {
      name: 'collateralParams',
      type: 'tuple[]',
      components: [
        { name: 'token', type: 'address' },
        { name: 'lltv', type: 'uint256' },
        { name: 'liquidationCursor', type: 'uint256' },
        { name: 'oracle', type: 'address' }
      ]
    },
    { name: 'maturity', type: 'uint256' },
    { name: 'rcfThreshold', type: 'uint256' },
    { name: 'enterGate', type: 'address' },
    { name: 'liquidatorGate', type: 'address' }
  ]
} as const

const SSTORE2_PREFIX = '0x600b380380600b5f395ff3' as const

/** Mirrors IdLib.toId — CREATE2 over the SSTORE2 blob, so the id is knowable before the market exists. */
function toId(market: unknown): Hex {
  const encoded = encodeAbiParameters([MARKET_TUPLE], [market as never])
  const initHash = keccak256(concat([SSTORE2_PREFIX, encoded]))
  return keccak256(
    concat(['0xff', MIDNIGHT, ('0x' + '00'.repeat(32)) as Hex, initHash])
  )
}

async function main() {
  const pk = process.env.PRIVATE_KEY_CREATOR ?? process.env.PRIVATE_KEY_LENDER
  if (!pk) throw new Error('PRIVATE_KEY_CREATOR (or PRIVATE_KEY_LENDER) not set')
  const account = privateKeyToAccount(pk as Hex)

  const publicClient = createPublicClient({ chain: robinhood, transport: http() })
  const wallet = createWalletClient({ account, chain: robinhood, transport: http() })

  // Maturity is measured against the CHAIN's clock, never this container's — the contract compares
  // block.timestamp, and that is the only clock that decides when the position becomes liquidatable.
  const head = await publicClient.getBlock({ blockTag: 'latest' })
  const maturity = head.timestamp + BigInt(MATURITY_MINUTES * 60)

  const market = {
    chainId: BigInt(CHAIN_ID),
    midnight: MIDNIGHT,
    loanToken: USDG,
    collateralParams: [
      { token: USDG, lltv: LLTV_98, liquidationCursor: CURSOR, oracle: IDENTITY_ORACLE }
    ],
    maturity,
    rcfThreshold: RCF_THRESHOLD,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  }

  const id = toId(market)
  console.log(`chain head      ${head.number} @ ${new Date(Number(head.timestamp) * 1000).toISOString()}`)
  console.log(`maturity        ${maturity} @ ${new Date(Number(maturity) * 1000).toISOString()}  (+${MATURITY_MINUTES}m)`)
  console.log(`creator         ${account.address}`)
  console.log(`MARKET_ID       ${id}`)

  const abi = [
    {
      type: 'function',
      name: 'touchMarket',
      stateMutability: 'nonpayable',
      inputs: [{ ...MARKET_TUPLE, name: 'market' }],
      outputs: [{ type: 'bytes32' }]
    }
  ] as const

  // Simulate first. A revert here is a parameter the deployment will not accept (an LLTV or cursor
  // that is not enabled, an unsorted collateral list), and broadcasting anyway just burns gas.
  await publicClient.simulateContract({
    address: MIDNIGHT, abi, functionName: 'touchMarket', args: [market as never], account
  })
  console.log('simulate        OK')

  if (process.env.SEND !== '1') {
    console.log('dry run — set SEND=1 to broadcast')
    return
  }

  const hash = await wallet.writeContract({
    address: MIDNIGHT, abi, functionName: 'touchMarket', args: [market as never], chain: robinhood
  })
  const rc = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`tx              ${hash}`)
  console.log(`status          ${rc.status}  block ${rc.blockNumber}`)
  if (rc.status !== 'success') throw new Error('touchMarket reverted')
  console.log(`\nMARKET_ID=${id}`)
}

main().catch(e => {
  console.error(e?.shortMessage ?? e?.message ?? e)
  process.exit(1)
})
