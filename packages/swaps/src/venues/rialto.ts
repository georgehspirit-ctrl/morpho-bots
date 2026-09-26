import { getAddress, isHex } from 'viem'

import type { RateLimitedClient } from '../http-client'
import type { PriceParameters, PriceQuote, QuoteParameters, Swap } from '../types'

import { QuoteError } from '../types'

/**
 * Rialto propAMM — a request-for-quote market-maker venue on Robinhood Chain (4663).
 *
 * Registered alongside the aggregators rather than instead of them: RFQ depth and AMM depth differ
 * per pair and per size, so the venue selector ranks them per quote and the best route wins. Some
 * pairs on this chain quote materially better through an RFQ maker than through on-chain pools.
 *
 * Timing matters more on Midnight than on Blue. The post-maturity incentive ramps from zero over 60
 * minutes, so the profitable window opens at the route's cost rather than at zero — a cheaper route
 * simply becomes viable earlier in that ramp.
 *
 * Two shape differences from the aggregator adapters, both load-bearing:
 *
 *  - `sell_amount` is a HUMAN DECIMAL string, not base units, while `min_buy_amount` comes back in
 *    RAW base units. The conversion is exact string arithmetic, never a float — a rounding error
 *    here over- or under-sells the seized collateral.
 *  - Settlement is `allowance`, not Permit2, because the taker is the Executor CONTRACT and a
 *    contract cannot produce a Permit2 signature. The spender comes from the quote's
 *    `issues.allowance.spender`.
 *
 * The bearer token is injected centrally by the HTTP client's VENUE_AUTH table, not here — venues in
 * this package never handle their own credentials.
 */

const RIALTO_BASE_URL = 'https://rialto-trade-api.rialto.xyz'
/** Rialto's own bound against its own quote. Our absolute floor is enforced separately, below. */
const RIALTO_SLIPPAGE_BPS = 150

/** The Rialto arm of the per-collateral swap config. */
type RialtoEntry = { baseUrl?: string }

type RialtoQuote = {
  tx?: { to?: string; data?: string; value?: string }
  sell_amount?: string
  buy_amount?: string
  min_buy_amount?: string
  issues?: { allowance?: { spender?: string } | null; balance?: unknown }
}

/**
 * Exact bigint -> decimal string. Deliberately not `formatUnits` + Number: a float round-trip on an
 * 18-decimal amount loses precision, and the amount we quote must equal the amount we approve.
 */
function toDecimalString(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac.length > 0 ? `${whole}.${frac}` : whole
}

/**
 * `tokenInDecimals` is optional on the shared parameter type because most venues quote in base units
 * and never need it. Rialto does, and guessing 18 would silently over-sell a 6-decimal token by 1e12,
 * so a missing value fails this venue loudly rather than quoting a wrong size.
 */
function requireDecimals(decimals: number | undefined): number {
  if (decimals === undefined) {
    throw new QuoteError('api_error', 'rialto: tokenInDecimals is required for a decimal-denominated venue')
  }
  return decimals
}

function quoteUrl(
  entry: RialtoEntry,
  params: { chainId: number; tokenIn: string; tokenOut: string; amountIn: bigint; tokenInDecimals?: number },
  taker: string
): string {
  const url = new URL('/quote', entry.baseUrl ?? RIALTO_BASE_URL)
  const q: Record<string, string> = {
    sell_token: params.tokenIn,
    buy_token: params.tokenOut,
    sell_amount: toDecimalString(params.amountIn, requireDecimals(params.tokenInDecimals)),
    taker,
    slippage_bps: String(RIALTO_SLIPPAGE_BPS),
    settlement: 'allowance',
    chain_id: String(params.chainId)
  }
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v)
  return url.toString()
}

/**
 * Firm Rialto quote with ready-built calldata.
 *
 * The caller's `minAcceptableAmountOut` is enforced HERE against the quote's own `min_buy_amount`,
 * rather than trusted to the venue. An earlier version of this venue ignored the caller's floor
 * entirely, leaving `RIALTO_SLIPPAGE_BPS` — a bound against Rialto's own quote — as the only
 * protection; a degraded quote could then turn a profitable liquidation into a losing one with no
 * say from our side. Throwing here fails only this venue, and the selector falls through to the next.
 */
export async function quoteRialto(
  client: RateLimitedClient,
  entry: RialtoEntry,
  params: QuoteParameters
): Promise<Swap> {
  const json = await client.getJson<RialtoQuote>({
    venue: 'rialto',
    url: quoteUrl(entry, params, params.executor)
  })

  if (json.issues?.balance) throw new QuoteError('no_route', 'rialto: insufficient balance for quote')
  if (!json.tx?.to || !json.tx.data) throw new QuoteError('no_route', 'rialto: no route for this pair/size')
  if (!isHex(json.tx.data)) throw new QuoteError('api_error', 'rialto: tx.data is not hex')

  // Raw base units, same as `minAcceptableAmountOut`, despite `sell_amount` going out as a decimal.
  const guaranteed = BigInt(json.min_buy_amount ?? '0')
  if (guaranteed < params.minAcceptableAmountOut) {
    throw new QuoteError(
      'no_route',
      `rialto: quote floor ${guaranteed} is below the required ${params.minAcceptableAmountOut}`
    )
  }

  const target = getAddress(json.tx.to)
  // Allowance settlement: approve the spender the quote names, which is not always the call target.
  // Falling back to the target keeps a quote without an explicit allowance issue usable, and both
  // come from the same signed response, so this does not widen trust beyond the venue itself.
  const spender = json.issues?.allowance?.spender
    ? getAddress(json.issues.allowance.spender)
    : target

  return {
    spender,
    target,
    value: BigInt(json.tx.value ?? '0'),
    callData: json.tx.data,
    amountIn: { source: 'fixed', value: params.amountIn },
    expectedAmountOut: BigInt(json.buy_amount ?? '0'),
    // The venue's own enforced bound, checked above against ours — reported rather than
    // reconstructed, the same trust boundary as 0x's `minBuyAmount` or 1inch's `minReturn`.
    amountOutMinimum: guaranteed,
    minOutSource: 'venue'
  }
}

/**
 * Indicative Rialto price for venue ranking. Same endpoint, but the result is used only to compare
 * output across venues, so a failure here must rank Rialto last rather than fail the liquidation.
 */
export async function priceRialto(
  client: RateLimitedClient,
  entry: RialtoEntry,
  params: PriceParameters
): Promise<PriceQuote> {
  const json = await client.getJson<RialtoQuote>({
    venue: 'rialto',
    url: quoteUrl(entry, params, params.executor)
  })

  const out = BigInt(json.buy_amount ?? '0')
  if (out === 0n) throw new QuoteError('no_route', 'rialto: no indicative price for this pair/size')
  return { amountOut: out }
}
