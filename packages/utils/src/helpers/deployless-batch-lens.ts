// Runs a per-item deployless "lens" contract through viem-dlc's paginated envelope and collects the
// results into a Map keyed by a caller-supplied key. Both liquidation bots' `state/lens.sol.ts`
// fetchers and both vault bots' delegate here.
//
// PORTED from prime-monorepo (packages/resolvers/src/rpc/read-deployless-batch-lens.ts), which is
// the same helper and was migrated to the 0.0.17+ envelope first. Keep the two in step rather than
// diverging: the dense-result realignment and the `declined` contract below are subtle, and prime
// carries the spec that pins them.

import { arrayifiedAbi, omit, policy } from '@morpho-org/viem-dlc'
import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type CallParameters,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionParameters,
  type ContractFunctionReturnType,
  getAbiItem,
  type Hex,
  type GetAbiItemParameters,
  type Transport
} from 'viem'
import { readContract } from 'viem/actions'
import { formatAbiItem } from 'viem/utils'

import type { Id } from '../types/index'

export type BatchLensTransportParameters = {
  'viem-dlc-cache': {
    ttl?: number
    delta?: number
  }
  'viem-dlc-deployless': {
    ttl?: undefined
    delta?: undefined
  }
}

export type BatchLensTransportType = Id<keyof BatchLensTransportParameters>

/**
 * Stable per-pair key for a batch-lens result map. `id` widens to {@link Hex} so both a market id
 * (bytes32) and an address-shaped id key uniformly.
 *
 * Also the liquidators' log join key (emitted verbatim as `id` — see "One join key per subject" in
 * `docs/CONVENTIONS.md`), which is why both halves are lowercased here rather than at each call site.
 */
export function lensKey(id: Hex, borrower: Address): string {
  return `${id.toLowerCase()}:${borrower.toLowerCase()}`
}

export type BatchLensClientParameters<client extends Client<Transport<BatchLensTransportType>>> =
  BatchLensTransportParameters[client['transport']['type']]

type Batch = NonNullable<Parameters<typeof policy>[0]['batch']>
type BatchGas = NonNullable<Batch['gas']>

/**
 * Per-lens gas model, optionally overridden per chain. Omit it until real traffic has been
 * measured: nothing is load-bearing — a chunk resizes from what its own pages report, so having no
 * model costs continuation round trips, never a result — and a model viem-dlc rejects as malformed
 * is ignored silently, in favour of packing by bytes alone. Populate from the viem-dlc wide event's
 * `fixed_gas` / `item_gas_avg` / `item_gas_stddev`, never guess.
 */
type BatchGasConfig = { default?: BatchGas; overrides?: Record<number, BatchGas> }

type BatchLensFunctionMutability = 'pure' | 'view'

/**
 * Names of the `view`/`pure` functions in `abi` that take one parameter and return one value —
 * the per-item shape the deployless envelope calls once per element.
 *
 * Constraining the name, rather than only the args it implies, is what makes a multi-parameter
 * function a compile error: `BatchLensInputElement` would otherwise infer its first parameter and
 * typecheck, leaving the mismatch to the runtime assertion in `readDeploylessBatchLens`.
 */
type BatchLensFunctionName<abi extends Abi> = ContractFunctionName<
  abi,
  BatchLensFunctionMutability
> &
  (Abi extends abi
    ? string
    : Extract<
        abi[number],
        {
          type: 'function'
          stateMutability: BatchLensFunctionMutability
          inputs: readonly [AbiParameter]
          outputs: readonly [AbiParameter]
        }
      >['name'])

/** The lens function's single parameter: one batch element. */
type BatchLensInputElement<abi extends Abi, functionName extends BatchLensFunctionName<abi>> =
  ContractFunctionArgs<abi, BatchLensFunctionMutability, functionName> extends readonly [
    infer input
  ]
    ? input
    : never

/**
 * The lens function's args as `ContractFunctionArgs` will accept them — the single-element tuple
 * when it is assignable, `never` otherwise. The guard is what lets this be passed as a constrained
 * type argument; `never` satisfies any constraint, and the true branch is proven by the `extends`.
 */
type BatchLensFunctionArgs<
  abi extends Abi,
  functionName extends BatchLensFunctionName<abi>,
  inputElement
> =
  readonly [inputElement] extends ContractFunctionArgs<
    abi,
    BatchLensFunctionMutability,
    functionName
  >
    ? readonly [inputElement]
    : never

/** The lens function's single return value: one batch element's result. */
type BatchLensOutputElement<
  abi extends Abi,
  functionName extends BatchLensFunctionName<abi>,
  inputElement
> = ContractFunctionReturnType<
  abi,
  BatchLensFunctionMutability,
  functionName,
  BatchLensFunctionArgs<abi, functionName, inputElement>
>

/**
 * What to do with elements the envelope could not serve. `'throw'` keeps the result dense, one
 * entry per distinct input.
 *
 * Under `'omit'` an absent key is **not** proof the element reverted: it could mean that viem-dlc
 * retried the element in a batch of 1, and the provider still rejected, either due to gas
 * constraints or a transient outage. If you need affirmation of a revert, use a `try` block +
 * sentinel in Solidity.
 */
export type DeclinedElementPolicy = 'omit' | 'throw'

/** Like `ReadContractParameters`, but tailored to batch lenses. */
type ReadDeploylessBatchLensParameters<
  abi extends Abi,
  functionName extends BatchLensFunctionName<abi>,
  inputElement,
  transportType extends BatchLensTransportType = BatchLensTransportType
> = Omit<ContractFunctionParameters<abi, BatchLensFunctionMutability, functionName>, 'args'> &
  Pick<CallParameters, 'blockNumber' | 'blockOverrides' | 'blockTag'> &
  Required<Pick<CallParameters, 'factory' | 'factoryData'>> & {
    /** One entry per element; each becomes its own per-item call inside the envelope. */
    args: readonly inputElement[]
    declined?: DeclinedElementPolicy
    batch?: Omit<Batch, 'gas'> & { gas?: BatchGasConfig }
  } & BatchLensTransportParameters[transportType]

type ReadDeploylessBatchLensParams<
  abi extends Abi,
  functionName extends BatchLensFunctionName<abi>,
  I extends BatchLensInputElement<abi, functionName>,
  K,
  V,
  transportType extends BatchLensTransportType
> = {
  client: Client<Transport<transportType>>
  parameters: ReadDeploylessBatchLensParameters<abi, functionName, I, transportType>
  key: (input: I) => K
  value: (input: I, output: BatchLensOutputElement<abi, functionName, I>) => V
}

/**
 * Read a per-item deployless lens across many elements in as few `eth_call`s as viem-dlc can
 * manage, and collect the results into a `Map`.
 *
 * The lens declares `f(T) returns (U)`; the envelope calls it once per element in its own frame
 * and pages. An element whose call reverts is **declined**, not fatal —
 * {@link DeclinedElementPolicy} decides whether that throws or simply leaves the entry out of the
 * map. Callers keyed on a dense result should keep the `'throw'` default.
 *
 * Deduplicate `args` before calling when elements can repeat: the cache transport collapses
 * duplicates, the deployless transport does not.
 */
export async function readDeploylessBatchLens<
  abi extends Abi,
  functionName extends BatchLensFunctionName<abi>,
  // NOTE: This constraint on `I` just provides editor hints when filling in `args`.
  // Without it, everything works except that `args` would be typed as `never` until properly filled in.
  I extends BatchLensInputElement<abi, functionName>,
  K,
  V,
  transportType extends BatchLensTransportType = BatchLensTransportType
>({
  client,
  parameters,
  key,
  value
}: ReadDeploylessBatchLensParams<abi, functionName, I, K, V, transportType>): Promise<Map<K, V>> {
  const { ttl, delta, batch, args, declined = 'throw', ...rest } = parameters

  if (args.length === 0) return new Map()

  const abiItem = getAbiItem({
    abi: parameters.abi,
    name: parameters.functionName,
    args: [args[0]]
  } as GetAbiItemParameters) as AbiFunction
  const humanReadableAbiItem = formatAbiItem(abiItem)

  if (abiItem.inputs.length !== 1) {
    throw new Error(
      `readBatchLens requires function that takes a single arg, got ${humanReadableAbiItem}.`
    )
  }
  if (abiItem.outputs.length !== 1) {
    throw new Error(
      `readBatchLens requires function that returns a single value, got ${humanReadableAbiItem}.`
    )
  }

  // `f(T[]) returns (U[] results, uint256[] skipped)` — the shape the envelope answers in. It is
  // never deployed; the envelope decodes the array and calls `f(T)` per element.
  const wireAbiItem = arrayifiedAbi(abiItem)

  const gas = resolveBatchGas(batch?.gas, client.chain?.id)
  // Chunks ride in the `eth_call` state override rather than the envelope's initcode, so a chunk is
  // bounded by the provider's request size and the frame's gas — never by EIP-3860. A provider that
  // ignores overrides is detected on the opening wave and its range re-fetched as initcode, which
  // the chain's own initcode limit bounds.
  const _batch = {
    compress: false as const,
    envelope: 'override' as const,
    ...omit(batch ?? {}, ['gas']),
    gas
  }

  // `wireAbiItem` is derived at runtime, so viem has no literal ABI to infer from and types this
  // call `never`. The annotation restates the outputs `ArrayifiedAbi` declares for it:
  // `(U[] results, uint256[] skipped)`.
  const [outputs, skipped]: [
    outputs: readonly BatchLensOutputElement<abi, functionName, I>[],
    skipped: readonly bigint[]
  ] = await readContract(client, {
    ...omit(rest, ['abi']),
    abi: [wireAbiItem],
    args: [args],
    stateOverride: [
      policy({
        cache:
          ttl !== undefined
            ? {
                blobKey: `${rest.address}.${humanReadableAbiItem}`,
                ttl,
                delta
              }
            : undefined,
        batch: _batch,
        abi: wireAbiItem
      })
    ]
  })

  if (!Array.isArray(outputs) || !Array.isArray(skipped)) {
    throw new Error(
      `readBatchLens received malformed output from ${rest.address}.${humanReadableAbiItem}`
    )
  }
  if (declined === 'throw' && skipped.length > 0) {
    throw new Error(
      `readBatchLens declined ${skipped.length}/${args.length} elements of ${rest.address}.${humanReadableAbiItem}`
    )
  }

  // `outputs` is dense — one entry per element the envelope did not decline — so it is consumed in
  // order against the elements that survived, not indexed by position in `args`.
  const declinedIndices = new Set(skipped.map(Number))
  const servedCountMismatch = () =>
    new Error(
      `readBatchLens received ${outputs.length} results for ${args.length - declinedIndices.size} served elements of ${rest.address}.${humanReadableAbiItem}`
    )

  const out = new Map<K, V>()
  let served = 0
  for (const [i, input] of args.entries()) {
    if (declinedIndices.has(i)) continue
    const output = outputs[served++]
    if (output === undefined) throw servedCountMismatch()
    out.set(key(input), value(input, output))
  }
  if (served !== outputs.length) throw servedCountMismatch()
  return out
}

function resolveBatchGas(
  gas: BatchGasConfig | undefined,
  chainId: number | undefined
): BatchGas | undefined {
  if (gas === undefined) return undefined
  if (chainId !== undefined && gas.overrides?.[chainId]) return gas.overrides[chainId]
  return gas.default
}
