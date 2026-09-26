import type { Logger } from '@repo/bot-kit'
import type { CursorPage, FetchPage } from '@repo/utils'
import type { Address, Hex } from 'viem'

import { collectPages, delay, fetchWithRetry } from '@repo/utils'
import createClient from 'openapi-fetch'
import { getAddress, isAddress, isHex } from 'viem'

import type { paths } from '../generated/markets-api'

/** A candidate position to evaluate: a (market, borrower) pair the API flagged as at-risk. */
export type BorrowerCandidate = { marketId: Hex; borrower: Address }

/**
 * One page of the cursor-paginated liquidation-candidates response. Rows stay `unknown`: the shape is
 * validated per row by {@link parseCandidate}, which is the only thing that reads them.
 */
export type CandidatePage = CursorPage<unknown>

/**
 * Fetches one page of candidates given the previous page's cursor (`null` for the first page). It is
 * injected into {@link discoverBorrowers} so the pagination + row parsing is unit-testable without a
 * network; the runtime adapter that actually calls the endpoint is {@link createApiCandidateSource}.
 */
export type FetchCandidatePage = FetchPage<unknown>

// Per-request tuning for the candidates endpoint: a short deadline. The retry policy lives in
// `@repo/utils` (see {@link fetchWithRetry}).
const REQUEST_TIMEOUT_MS = 5_000
/** Page size requested explicitly; the spec documents no maximum and no default. Fewer round-trips. */
const PAGE_LIMIT = 100

/**
 * Hard cap on pages followed in one discovery pass — a runaway-cursor backstop, NOT an expected
 * limit. {@link PAGE_LIMIT} × this = 10,000 candidates, far above any realistic Midnight universe.
 * Hitting it is logged loud (`discover.max_pages`) because silently truncating a paginated candidate
 * set is *under-inclusion* — a liquidatable position we would then never see (over-inclusion is
 * harmless; the on-chain lens filters non-liquidatable pairs).
 */
export const MAX_DISCOVERY_PAGES = 100

/**
 * The candidates operation path — a literal key of the generated {@link paths}, so `client.GET(LIQUIDATION_CANDIDATES_PATH)`
 * is type-checked against the spec. The runtime base URL is derived by stripping this suffix from the
 * configured endpoint URL (see {@link createApiCandidateSource}).
 *
 * Exported because `LIQUIDATION_CANDIDATES_API_URL` is the base for the sibling tokens endpoint too:
 * that suffix, not the tokens one, is what the configured URL ends with, so stripping it is the only
 * way to recover a gateway prefix (see `createTokenPriceSource`).
 */
export const LIQUIDATION_CANDIDATES_PATH = '/markets/midnight/liquidation-candidates'

// Validates and normalizes one raw response row into a candidate, or `null` if malformed. Only
// `market_id` + `borrower` feed the pipeline — the lens re-derives everything else (debt, health,
// gates, maturity) fresh on-chain — so the rest of the row is intentionally ignored.
function parseCandidate(row: unknown): BorrowerCandidate | null {
  if (typeof row !== 'object' || row === null) return null
  const { market_id: marketId, borrower } = row as { market_id?: unknown; borrower?: unknown }
  if (
    typeof marketId === 'string' &&
    isHex(marketId) &&
    typeof borrower === 'string' &&
    isAddress(borrower, { strict: false })
  ) {
    return { marketId, borrower: getAddress(borrower) }
  }
  return null
}

/**
 * Reads the full over-inclusive (market, borrower) candidate universe from the liquidation-candidates
 * endpoint, following the cursor across every page. The page fetcher is injected so this parsing is
 * unit-testable without a live endpoint; the runtime adapter is {@link createApiCandidateSource}.
 * Malformed rows are skipped and (market, borrower) pairs are de-duplicated across pages. Over-
 * inclusion is harmless — the on-chain lens drops non-liquidatable pairs — but a truncated page walk
 * would be under-inclusion, so the {@link MAX_DISCOVERY_PAGES} backstop logs loud rather than
 * silently stopping.
 */
export async function discoverBorrowers(
  fetchPage: FetchCandidatePage,
  deps: { logger: Logger; maxPages?: number }
): Promise<BorrowerCandidate[]> {
  const maxPages = deps.maxPages ?? MAX_DISCOVERY_PAGES
  const { rows, pages, truncated } = await collectPages(fetchPage, { maxPages })
  if (truncated) {
    deps.logger.warn('discover.max_pages', { pages, cap: maxPages, rows: rows.length })
  }

  const seen = new Set<string>()
  const candidates: BorrowerCandidate[] = []
  for (const row of rows) {
    const candidate = parseCandidate(row)
    if (!candidate) continue
    const key = `${candidate.marketId}:${candidate.borrower}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }

  return candidates
}

/**
 * Parses an operator-supplied list of `marketId:borrower` pairs to union into every discovery pass.
 * Entries are separated by whitespace and/or commas; malformed entries are logged and skipped rather
 * than failing the bot, since one typo must not take liquidation coverage to zero.
 *
 * WHY THIS EXISTS. {@link createApiCandidateSource} is the only borrower source, and it can only
 * return markets Morpho indexes. Nothing on Robinhood Chain (4663) is indexed today — `markets.listed`
 * reads 0 and the candidates endpoint returns nothing for our market ids — so discovery yields no
 * pairs at all and no position is ever evaluated, matured or not. A bot that looks perfectly healthy
 * (ticking every block, whitelist populated) will still never liquidate. This is the floor under that.
 *
 * IT IS A FLOOR, NOT DISCOVERY. It can only ever surface borrowers someone already knew to list, so
 * it does NOT give coverage of arbitrary third-party borrowers on those markets. Treat a market whose
 * only coverage is this list as covered for these borrowers and no others, until either Morpho indexes
 * it or an on-chain log scan replaces this.
 */
export function parseStaticCandidates(
  raw: string | undefined,
  deps: { logger: Logger }
): BorrowerCandidate[] {
  const entries = (raw ?? '').split(/[\s,]+/).filter(entry => entry.length > 0)
  const seen = new Set<string>()
  const candidates: BorrowerCandidate[] = []
  const rejected: string[] = []
  for (const entry of entries) {
    // rsplit on ':' — a market id contains no colon, so this stays correct if a future format ever
    // prefixes the pair.
    const split = entry.lastIndexOf(':')
    const marketId = split === -1 ? '' : entry.slice(0, split)
    const borrower = split === -1 ? '' : entry.slice(split + 1)
    if (!isHex(marketId) || marketId.length !== 66 || !isAddress(borrower, { strict: false })) {
      rejected.push(entry)
      continue
    }
    const candidate: BorrowerCandidate = {
      marketId: marketId as Hex,
      borrower: getAddress(borrower)
    }
    const key = `${candidate.marketId}:${candidate.borrower}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }
  if (rejected.length > 0) {
    deps.logger.warn('discover.static_rejected', {
      rejected,
      detail: 'expected marketId:borrower (0x + 64 hex, 0x + 40 hex)'
    })
  }
  return candidates
}

/** The `fetch` shape `openapi-fetch` calls — a single `Request`. The global `fetch` satisfies it. */
type FetchLike = (request: Request) => Promise<Response>

/**
 * Runtime adapter: a {@link FetchCandidatePage} backed by the liquidation-candidates HTTP endpoint,
 * via a typed `openapi-fetch` client generated from the Markets Internal API spec. `openapi-fetch`
 * builds the URL, serializes the query, and parses/types the body; this wrapper keeps the bespoke
 * retry policy it does NOT provide via {@link fetchWithRetry} (429/5xx/network, honoring
 * `Retry-After`), with a per-request {@link REQUEST_TIMEOUT_MS} deadline. `client.GET` resolves on
 * 4xx/5xx (it only throws on network/abort), so `response.status`/`Retry-After` stay reachable. A
 * non-retryable failure throws; the caller catches it (logs `discover.error`) and proceeds so the
 * pending queue is still driven that block. `fetchImpl`/`sleep` are injectable for tests.
 *
 * `deps.url` is the fully-qualified endpoint URL from config; the client base URL is it minus the
 * fixed {@link LIQUIDATION_CANDIDATES_PATH} suffix (falling back to the origin). An operator override of
 * `LIQUIDATION_CANDIDATES_API_URL` therefore changes host/prefix, but the request path is fixed by
 * the typed client.
 */
export function createApiCandidateSource(deps: {
  url: string
  chainId: number
  healthFactorLte: number
  limit?: number
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}): FetchCandidatePage {
  const sleep = deps.sleep ?? delay
  const baseUrl = deps.url.endsWith(LIQUIDATION_CANDIDATES_PATH)
    ? deps.url.slice(0, -LIQUIDATION_CANDIDATES_PATH.length)
    : new URL(deps.url).origin
  const client = createClient<paths>({ baseUrl, fetch: deps.fetchImpl ?? fetch })

  return async cursor => {
    const body = await fetchWithRetry(
      () =>
        client.GET(LIQUIDATION_CANDIDATES_PATH, {
          params: {
            query: {
              chain_ids: [deps.chainId],
              health_factor_lte: deps.healthFactorLte,
              // `include_matured` is always sent: a matured market is liquidatable regardless of
              // health factor and the on-chain gate liquidates on maturity, so those positions must
              // be in the candidate set even when their health factor sits above `healthFactorLte`.
              include_matured: 'true',
              limit: deps.limit ?? PAGE_LIMIT,
              ...(cursor ? { cursor } : {})
            }
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }),
      { label: 'liquidation-candidates', sleep }
    )

    const nextCursor =
      typeof body.cursor === 'string' && body.cursor.length > 0 ? body.cursor : null
    const rows = Array.isArray(body.data) ? body.data : []
    return { cursor: nextCursor, data: rows }
  }
}
