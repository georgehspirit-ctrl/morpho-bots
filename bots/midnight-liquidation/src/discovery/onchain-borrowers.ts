import type { Logger } from '@repo/bot-kit'
import type { Address, Client, Hex } from 'viem'

import { getAddress } from 'viem'
import { getBlockNumber, getLogs } from 'viem/actions'

import type { BorrowerCandidate } from './borrowers'

/**
 * On-chain borrower discovery: the (market, borrower) universe read from Midnight's own event log,
 * with no indexer in the loop.
 *
 * WHY THIS EXISTS. {@link createApiCandidateSource} is the only other source and it can only return
 * markets Morpho indexes. Morpho indexes nothing on Robinhood Chain — `markets.listed` reads 0 — so on
 * that chain the API source yields no pairs at all and the bot will sit through a maturity without
 * ever evaluating a position, while looking perfectly healthy (ticking every block, whitelist
 * populated, signer funded). `EXTRA_CANDIDATES` was the stopgap, but it is a hand-maintained list and
 * therefore blind to any borrower nobody thought to write down. This is the actual fix.
 *
 * Deliberately OVER-INCLUSIVE, in three ways, because a false positive costs one lens read while a
 * false negative is a position we never liquidate:
 *  - every party to a {@link TAKE} is taken, maker and taker alike: which side carries the debt
 *    depends on `offerIsBuy`, which is not indexed, and the lens re-derives debt on-chain anyway;
 *  - {@link UPDATE_POSITION} and {@link LIQUIDATE} are scanned too, so a position that changed hands
 *    or was partially liquidated is still a candidate;
 *  - a party is never forgotten once seen, even after its debt reaches zero.
 * Market filtering is NOT done here — {@link planCandidates}' caller applies the fail-closed market
 * whitelist to every candidate, so narrowing here would only duplicate that and risk disagreeing.
 */

/** `Take(address,bytes32,bytes32 indexed,bool,address indexed,…,address indexed,…)` — maker + taker. */
const TAKE: Hex = '0xbd88656d0ee14d32d4f74f814f6ccb5c750a4c542d6fdf83ee00ddca4edebff0'
/** `UpdatePosition(bytes32 indexed,address indexed,…)` — any account holding a position. */
const UPDATE_POSITION: Hex = '0x8fd212bc8fa18d807a9b47aa2de07104bf036cfcef8ea259157085a1b618a77c'
/** `Liquidate(bytes32 indexed,address indexed,address indexed,…)` — a borrower that may retain debt. */
const LIQUIDATE: Hex = '0xb137b989b9fd54b984273db8f16364f52f383aaca56076a320c1896e9fc2dad9'

/**
 * Topics whose *third* indexed slot is a token rather than an account. {@link LIQUIDATE} indexes
 * `(id, token, borrower)`, so blindly reading every indexed slot as an account would add the loan
 * token to the candidate set on every liquidation — harmless to the lens but pure noise in the logs.
 */
const TOPIC_SLOTS_TO_SKIP: Partial<Record<Hex, readonly number[]>> = { [LIQUIDATE]: [0] }

const SCANNED_TOPICS: readonly Hex[] = [TAKE, UPDATE_POSITION, LIQUIDATE]

/**
 * Default block span per `eth_getLogs`. Robinhood Chain answers `fromBlock: 0, toBlock: latest`
 * directly today — its whole Midnight history is three `Take` events — but a span that works at
 * current volume is not a span that keeps working, so the scan chunks regardless.
 */
export const DEFAULT_CHUNK_BLOCKS = 500_000n

/**
 * A chunk returning at least this many logs is treated as possibly truncated and re-queried as two
 * halves. This is the load-bearing safety property of this module: Robinhood Chain's `eth_getLogs`
 * truncates SILENTLY — it returns a short list with no error and no flag — and a silently short list
 * is under-inclusion, i.e. a liquidatable position the bot never sees. Comparing a range against the
 * sum of its halves detects that without relying on any provider-specific cap or error string.
 */
export const LOGS_SUSPECT_THRESHOLD = 2_000

const candidateKey = (candidate: BorrowerCandidate) => `${candidate.marketId}:${candidate.borrower}`

/** One `eth_getLogs`, split in half and retried whenever the result looks truncated. */
async function scanRange(
  client: Client,
  params: {
    midnight: Address
    topic: Hex
    fromBlock: bigint
    toBlock: bigint
    logger: Logger
  }
): Promise<BorrowerCandidate[]> {
  const { midnight, topic, fromBlock, toBlock, logger } = params
  const logs = await getLogs(client, {
    address: midnight,
    fromBlock,
    toBlock,
    // viem's typed `event`/`args` overloads would need the full ABI item; the raw topic filter is the
    // whole query here and keeps the event identities in one place at the top of this file.
    topics: [topic]
  } as Parameters<typeof getLogs>[1])

  if (logs.length >= LOGS_SUSPECT_THRESHOLD) {
    if (toBlock > fromBlock) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n
      logger.warn('discover.onchain_resplit', {
        topic,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        returned: logs.length,
        detail: 'result may be silently truncated — re-querying as halves'
      })
      const [lower, upper] = await Promise.all([
        scanRange(client, { ...params, toBlock: mid }),
        scanRange(client, { ...params, fromBlock: mid + 1n })
      ])
      return [...lower, ...upper]
    }
    // A single block cannot be split further. Report it loudly rather than silently under-including:
    // coverage for that block is not guaranteed, and that is exactly the failure this module exists
    // to prevent.
    logger.error('discover.onchain_unsplittable', {
      topic,
      block: fromBlock.toString(),
      returned: logs.length,
      detail: 'single block at the suspect threshold — coverage for it may be incomplete'
    })
  }

  const skip = TOPIC_SLOTS_TO_SKIP[topic] ?? []
  const out: BorrowerCandidate[] = []
  for (const log of logs) {
    const topics = log.topics as readonly Hex[]
    const marketId = topics[1]
    if (!marketId) continue
    topics.slice(2).forEach((slot, index) => {
      if (skip.includes(index) || !slot) return
      // An indexed address is the low 20 bytes of the 32-byte topic.
      out.push({ marketId, borrower: getAddress(`0x${slot.slice(26)}`) })
    })
  }
  return out
}

/**
 * Accumulating on-chain candidate source.
 *
 * The first call scans `[fromBlock, head]`; each later call scans only what is new and unions it into
 * the set already found, so a party is never dropped once seen and steady-state cost is a handful of
 * `eth_getLogs` over a few hundred blocks. The scan window ends at a concrete head read once per
 * pass — never `latest` per-query — so two topics in the same pass cannot cover different ranges and
 * leave a gap between them.
 *
 * A failing pass throws with the cursor unmoved: the caller logs and proceeds on the previous set, and
 * the next pass re-covers the same blocks. Never advance the cursor past a range that was not read.
 */
export function createOnchainCandidateSource(deps: {
  client: Client
  midnight: Address
  fromBlock: bigint
  chunkBlocks?: bigint
  logger: Logger
}): () => Promise<BorrowerCandidate[]> {
  const chunkBlocks = deps.chunkBlocks && deps.chunkBlocks > 0n ? deps.chunkBlocks : DEFAULT_CHUNK_BLOCKS
  const seen = new Map<string, BorrowerCandidate>()
  let cursor: bigint | null = null

  return async () => {
    const head = await getBlockNumber(deps.client)
    const from = cursor === null ? deps.fromBlock : cursor + 1n
    if (from > head) return [...seen.values()]

    const found: BorrowerCandidate[] = []
    for (let start = from; start <= head; start += chunkBlocks) {
      const end = start + chunkBlocks - 1n > head ? head : start + chunkBlocks - 1n
      for (const topic of SCANNED_TOPICS) {
        found.push(
          ...(await scanRange(deps.client, {
            midnight: deps.midnight,
            topic,
            fromBlock: start,
            toBlock: end,
            logger: deps.logger
          }))
        )
      }
    }

    let added = 0
    for (const candidate of found) {
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.set(key, candidate)
      added += 1
    }
    // Only now, with every range in this pass read successfully, does the cursor move.
    cursor = head
    if (added > 0) {
      deps.logger.info('discover.onchain', {
        scannedFrom: from.toString(),
        scannedTo: head.toString(),
        added,
        total: seen.size
      })
    }
    return [...seen.values()]
  }
}
