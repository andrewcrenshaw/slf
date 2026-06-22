import type { Grant, Lens, Frame, GateOutcome } from './types.js'
import { applySubstrateGate } from './gates/substrate-gate.js'
import { applyLensProjection } from './gates/lens-projection.js'
import { applyFrameCheck } from './gates/frame-check.js'
import { applyHitlGate } from './gates/hitl-gate.js'
import { buildReceipt, signReceipt, type Receipt } from './receipt.js'
import type { ReceiptStore } from './receipt-store.js'
import { verifyGrantCached } from './grant-cache.js'
import { evaluateAuthoredGates, verifyConsumerRequest } from './grant.js'

/**
 * The gates whose evaluation governs what gets disclosed. A receipt that names
 * disclosed fields but omits these from `gates_evaluated` is a skip-evaluation
 * forgery (PROPOSAL-SLF §6.1): disclosure without honest evaluation. This set is
 * the authoritative list the receipt layer checks against; it MUST stay in sync
 * with the gate names pushed by evaluateGateChain below.
 */
export const DISCLOSURE_GOVERNING_GATES = ['substrate-gate', 'lens-projection'] as const

export interface ReadRequest {
  requestId: string
  lens: Lens
  frame: Frame
  approvalToken?: string
  /**
   * SP-3 (D4): the DID of the consumer opening this read. Opt-in — when present
   * the engine binds the consumer to the grant audience and requires a
   * consumer-signed request token. Absent, the read behaves as before.
   */
  holderDid?: string
  /** SP-3 (D4): consumer request token proving control of `holderDid` for this requestId. */
  consumerRequest?: string
}

export interface FactGateResult {
  fact: Record<string, unknown>
  reasonCode: string
}

export interface GateChainResult {
  outcome: GateOutcome
  disclosed: Array<Record<string, unknown>>
  redacted: FactGateResult[]
  gatesEvaluated: string[]
  reasonCode?: string
  disclosurePreview?: string
}

export interface SubstrateFetcher {
  fetchFacts(grant: Grant): Promise<Array<Record<string, unknown>>>
}

/**
 * What a read-in-place boundary releases when an external consumer reads
 * subject-held substrate (SP-4). Only `released` — the facts that passed the
 * disclosure-governing gates — crosses the boundary into the consumer's control.
 * `withheld` carries redaction records for the receipt's honest field-level
 * accounting; a conforming boundary populates them with field-name metadata only,
 * never the withheld values, so no full copy of the substrate leaves the subject's
 * domain. `gatesEvaluated` names the disclosure-governing gates run behind the wall.
 */
export interface ReadInPlaceRelease {
  released: Array<Record<string, unknown>>
  withheld: FactGateResult[]
  gatesEvaluated: string[]
}

/**
 * A substrate held under the subject's control that gates reads IN PLACE (SP-4).
 * Rather than hand the engine the full substrate via {@link SubstrateFetcher.fetchFacts}
 * — which would copy the substrate out of the subject's control — it evaluates the
 * disclosure-governing gates behind its own boundary and releases only the facts
 * that pass. The engine prefers {@link readInPlace} whenever a fetcher provides it,
 * so a subject-held read never demands a full copy. The capability is symmetric:
 * the engine runs the identical gate logic ({@link applyDisclosureGates}) whether
 * the substrate is issuer-held or subject-held.
 */
export interface ReadInPlaceFetcher extends SubstrateFetcher {
  readInPlace(grant: Grant, request: ReadRequest): Promise<ReadInPlaceRelease>
}

/** True when a fetcher can gate a read in place behind a subject-controlled boundary (SP-4). */
export function isReadInPlaceFetcher(fetcher: SubstrateFetcher): fetcher is ReadInPlaceFetcher {
  return typeof (fetcher as Partial<ReadInPlaceFetcher>).readInPlace === 'function'
}

export interface GateChainOpts {
  /** When true, verify grant signature via the module-level cache before running gates. */
  useGrantCache?: boolean
}

/**
 * Apply the disclosure-governing gates to a set of raw facts: the substrate gate
 * (expiry, scope, restrictive tags), any subject-authored restrict gates (SP-3 D3),
 * and the lens projection. Returns the disclosed facts, the redaction records, and
 * the ordered names of the gates evaluated.
 *
 * This is the substrate-protective core of the gate chain, factored out so it runs
 * IDENTICALLY in two topologies (SP-4): in-process for issuer-held substrate, and
 * behind a {@link ReadInPlaceFetcher} boundary for subject-held substrate. The
 * engine "operating identically whether the substrate is issuer-held or
 * subject-held" is this one shared call — not two parallel implementations.
 */
export async function applyDisclosureGates(
  grant: Grant,
  request: ReadRequest,
  rawFacts: Array<Record<string, unknown>>,
): Promise<{
  disclosed: Array<Record<string, unknown>>
  redacted: FactGateResult[]
  gatesEvaluated: string[]
}> {
  const redacted: FactGateResult[] = []
  const afterSubstrate: Array<Record<string, unknown>> = []

  // Gate 1: substrate gate (expiry, scope, gate tags), then subject-authored gates.
  for (const fact of rawFacts) {
    const r = applySubstrateGate(grant, fact)
    if (!r.pass) {
      redacted.push({ fact, reasonCode: r.reasonCode! })
      continue
    }
    // A subject-authored restrict gate narrows disclosure regardless of who issued
    // the grant: disclosed = grant-scope INTERSECT subject-gates.
    const subjectGate = await evaluateAuthoredGates(grant, fact)
    if (!subjectGate.pass) {
      redacted.push({ fact, reasonCode: subjectGate.reasonCode! })
      continue
    }
    afterSubstrate.push(fact)
  }

  // Gate 2: lens projection (entity_type filter).
  const lensResult = applyLensProjection(request.lens, afterSubstrate)
  redacted.push(...lensResult.redacted)

  return {
    disclosed: lensResult.disclosed,
    redacted,
    gatesEvaluated: ['substrate-gate', 'lens-projection'],
  }
}

async function checkGrantValidity(
  grant: Grant,
  opts?: GateChainOpts,
): Promise<GateChainResult | null> {
  if (!opts?.useGrantCache) return null
  const grantCheck = await verifyGrantCached(grant)
  if (grantCheck.valid) return null
  return {
    outcome: 'denied',
    disclosed: [],
    redacted: [],
    gatesEvaluated: [],
    reasonCode: grantCheck.reason ?? 'grant-invalid',
  }
}

// SP-3 (D4): consumer binding. When the read declares a holder identity, the
// consumer must equal the grant audience and prove control of that key for this
// exact request. This closes the anyone-can-replay-a-grant gap.
async function checkConsumerBinding(
  grant: Grant,
  request: ReadRequest,
): Promise<GateChainResult | null> {
  if (request.holderDid === undefined) return null
  if (grant.audience !== request.holderDid) {
    return {
      outcome: 'denied',
      disclosed: [],
      redacted: [],
      gatesEvaluated: [],
      reasonCode: 'consumer-mismatch',
    }
  }
  const bound = await verifyConsumerRequest(
    request.consumerRequest,
    request.holderDid,
    request.requestId,
  )
  if (!bound) {
    return {
      outcome: 'denied',
      disclosed: [],
      redacted: [],
      gatesEvaluated: [],
      reasonCode: 'consumer-request-invalid',
    }
  }
  return null
}

// SP-4: whether the fetcher is issuer-held or subject-held, the same gate logic
// (applyDisclosureGates) runs — the branch only decides where it executes.
async function runDisclosureGates(
  grant: Grant,
  request: ReadRequest,
  fetcher: SubstrateFetcher,
): Promise<{ disclosed: Array<Record<string, unknown>>; redacted: FactGateResult[]; gatesEvaluated: string[] }> {
  if (isReadInPlaceFetcher(fetcher)) {
    const release = await fetcher.readInPlace(grant, request)
    return {
      disclosed: release.released,
      redacted: [...release.withheld],
      gatesEvaluated: [...release.gatesEvaluated],
    }
  }
  const rawFacts = await fetcher.fetchFacts(grant)
  return applyDisclosureGates(grant, request, rawFacts)
}

export async function evaluateGateChain(
  grant: Grant,
  request: ReadRequest,
  fetcher: SubstrateFetcher,
  opts?: GateChainOpts,
): Promise<GateChainResult> {
  const grantError = await checkGrantValidity(grant, opts)
  if (grantError) return grantError

  const consumerError = await checkConsumerBinding(grant, request)
  if (consumerError) return consumerError

  const { disclosed, redacted: allRedacted, gatesEvaluated } = await runDisclosureGates(
    grant,
    request,
    fetcher,
  )

  const frameResult = applyFrameCheck(grant, request.frame.id)
  gatesEvaluated.push('frame-check')

  if (!frameResult.pass) {
    allRedacted.push(...disclosed.map(f => ({ fact: f, reasonCode: 'frame-not-authorized' })))
    return {
      outcome: 'denied',
      disclosed: [],
      redacted: allRedacted,
      gatesEvaluated,
      reasonCode: 'frame-not-authorized',
    }
  }

  const hitlResult = applyHitlGate(
    request.frame.requiresApproval,
    request.requestId,
    disclosed,
    request.approvalToken,
  )
  gatesEvaluated.push('hitl-gate')

  if (hitlResult.outcome === 'pending_approval') {
    return {
      outcome: 'pending_approval',
      disclosed: [],
      redacted: allRedacted,
      gatesEvaluated,
      disclosurePreview: hitlResult.disclosurePreview,
    }
  }

  if (hitlResult.outcome === 'denied') {
    allRedacted.push(...disclosed.map(f => ({ fact: f, reasonCode: hitlResult.reasonCode! })))
    return {
      outcome: 'denied',
      disclosed: [],
      redacted: allRedacted,
      gatesEvaluated,
      reasonCode: hitlResult.reasonCode,
    }
  }

  return {
    outcome: 'granted',
    disclosed,
    redacted: allRedacted,
    gatesEvaluated,
  }
}

// --- Receipt emission (SLF-3) ---------------------------------------------

/** Terminal outcomes that MUST emit exactly one receipt. pending_approval is a pause, not terminal. */
const TERMINAL_OUTCOMES: ReadonlyArray<GateOutcome> = ['granted', 'denied', 'partial', 'error']

export interface ReceiptEmissionContext {
  store: ReceiptStore
  actorSecretKey: Uint8Array
  /** Clock injection for deterministic tests; defaults to Date.now. */
  now?: () => number
}

export interface GateChainOutcomeWithReceipt {
  result: GateChainResult
  receipt: Receipt | null
}

/**
 * Run the gate chain and emit exactly one signed, hash-chained receipt for every
 * terminal outcome (granted | denied | partial | error). A non-terminal
 * pending_approval emits no receipt. Engine errors are caught and recorded as an
 * `error` receipt so no terminal outcome is ever receiptless.
 *
 * The receipt carries the grant's data subject (SP-1/SP-4): when a grant names a
 * `subject`, the emitted receipt is addressed to that subject, so a real gated
 * read against subject-held substrate yields a receipt the subject can hold and
 * independently verify. A grant without a subject falls back to UNSPECIFIED_SUBJECT.
 */
export async function evaluateGateChainWithReceipt(
  grant: Grant,
  request: ReadRequest,
  fetcher: SubstrateFetcher,
  ctx: ReceiptEmissionContext,
  opts?: GateChainOpts,
): Promise<GateChainOutcomeWithReceipt> {
  let result: GateChainResult
  try {
    result = await evaluateGateChain(grant, request, fetcher, opts)
  } catch (err) {
    result = {
      outcome: 'error',
      disclosed: [],
      redacted: [],
      gatesEvaluated: [],
      reasonCode: err instanceof Error ? `engine-error: ${err.message}` : 'engine-error',
    }
  }

  if (!TERMINAL_OUTCOMES.includes(result.outcome)) {
    return { result, receipt: null }
  }

  const previous = await ctx.store.head()
  const timestamp = (ctx.now ?? Date.now)()
  const unsigned = buildReceipt(result, grant, {
    timestamp,
    prevReceiptId: previous?.id,
    chainId: previous?.chainId,
    subjectRef: grant.subject,
    custodian: isReadInPlaceFetcher(fetcher) ? grant.subject : undefined,
  })
  const receipt = await signReceipt(unsigned, ctx.actorSecretKey)
  await ctx.store.append(receipt)
  return { result, receipt }
}
