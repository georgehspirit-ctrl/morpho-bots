import type { Address, Client, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { BaseError } from 'viem'
import { call } from 'viem/actions'

export type SimulateResult = {
  /**
   * `ok` — the call succeeds from this EOA, safe to broadcast. `revert` — do not send. Callers gate
   * on `ok` only; the domain meaning of a revert belongs at the call site.
   */
  status: 'ok' | 'revert'
  reason?: string
  /**
   * Raw revert data, and the calldata that produced it, when the call reverted.
   *
   * `reason` alone is not enough to diagnose an Executor revert. `Executor._revert` bubbles an inner
   * failure with `require(returnData.length > 0)`, so an inner call that reverts with EMPTY data makes
   * that require revert empty in turn — viem then reports only "Execution reverted for an unknown
   * reason." and the actual cause is unrecoverable from the log. Carrying the bytes lets the exact
   * call be replayed and decoded by hand.
   */
  revertData?: string
  calldata?: Hex
}

/**
 * Simulates one transaction as an `eth_call` from `eoa`, byte-for-byte what would be broadcast
 * (`value` included — defaulting to 0n keeps the sim and the send in lockstep). Any revert is
 * reported as `{ status: 'revert', reason }` rather than thrown; what a revert *means* is the
 * caller's domain knowledge. No signer; never sends.
 */
export const simulateCall = async (
  client: Client,
  params: { eoa: Address; to: Address; data: Hex; value?: bigint }
): Promise<SimulateResult> => {
  const { error } = await tryCatch(
    call(client, {
      account: params.eoa,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n
    })
  )
  if (!error) return { status: 'ok' }
  // Walk the cause chain for the first `data` field — viem nests the revert bytes at varying depth
  // depending on which layer classified the error. Guarded against a cyclic chain.
  const revertData = (() => {
    const seen = new Set<unknown>()
    let current: unknown = error
    while (current && !seen.has(current)) {
      seen.add(current)
      const data = (current as { data?: unknown }).data
      if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) return data
      current = (current as { cause?: unknown }).cause
    }
    return undefined
  })()
  return {
    status: 'revert',
    reason: error instanceof BaseError ? error.shortMessage : error.message,
    revertData,
    calldata: params.data
  }
}

/**
 * Simulates the real liquidation — `Executor.exec_606BaXt(...)` from the liquidator EOA,
 * byte-for-byte what gets broadcast. The Executor self-funds via the in-callback swap, so a success
 * means the seized collateral covered the repay (incl. `amountOutMinimum` slippage) and both tokens
 * swept clean. Any revert — not-liquidatable, swap slippage, repay shortfall — means do not
 * broadcast; the tick gates on `ok` only. No signer; never sends.
 *
 * The full-drain (zero-residual) invariant is enforced **structurally**: each bot's
 * `encodeLiquidationExec` always appends two skims that transfer the Executor's entire loan +
 * collateral balance to the EOA, so a successful exec ends at zero balance for standard ERC20s. The
 * literal post-tx zero-balance assertion lives in the bots' anvil fork suites — viem 2.47 has no
 * `eth_simulateV1` helper to read post-state balances inline.
 */
export const simulateLiquidationExec = (
  client: Client,
  params: { executooor: Address; eoa: Address; data: Hex; value?: bigint }
): Promise<SimulateResult> =>
  simulateCall(client, {
    eoa: params.eoa,
    to: params.executooor,
    data: params.data,
    value: params.value
  })
