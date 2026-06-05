import type { Grant, Lens, Frame, GateOutcome } from './types.js'
import { applySubstrateGate } from './gates/substrate-gate.js'
import { applyLensProjection } from './gates/lens-projection.js'
import { applyFrameCheck } from './gates/frame-check.js'
import { applyHitlGate } from './gates/hitl-gate.js'
import { buildReceipt, signReceipt, type Receipt } from './receipt.js'
import type { ReceiptStore } from './receipt-store.js'
import { verifyGrantCached } from './grant-cache.js'

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

export interface GateChainOpts {
  /** When true, verify grant signature via the module-level cache before running gates. */
  useGrantCache?: boolean
}

export async function evaluateGateChain(
  grant: Grant,
  request: ReadRequest,
  fetcher: SubstrateFetcher,
  opts?: GateChainOpts,
): Promise<GateChainResult> {
  if (opts?.useGrantCache) {
    const grantCheck = await verifyGrantCached(grant)
    if (!grantCheck.valid) {
      return {
        outcome: 'denied',
        disclosed: [],
        redacted: [],
        gatesEvaluated: [],
        reasonCode: grantCheck.reason ?? 'grant-invalid',
      }
    }
  }

  const gatesEvaluated: string[] = []
  const allRedacted: FactGateResult[] = []

  // Gate 1: substrate gate (expiry, scope, gate tags)
  const rawFacts = await fetcher.fetchFacts(grant)
  const afterSubstrate: Array<Record<string, unknown>> = []

  for (const fact of rawFacts) {
    const r = applySubstrateGate(grant, fact)
    if (r.pass) {
      afterSubstrate.push(fact)
    } else {
      allRedacted.push({ fact, reasonCode: r.reasonCode! })
    }
  }
  gatesEvaluated.push('substrate-gate')

  // Gate 2: lens projection (entity_type filter)
  const lensResult = applyLensProjection(request.lens, afterSubstrate)
  allRedacted.push(...lensResult.redacted)
  gatesEvaluated.push('lens-projection')

  // Gate 3: frame check (request-level)
  const frameResult = applyFrameCheck(grant, request.frame.id)
  gatesEvaluated.push('frame-check')

  if (!frameResult.pass) {
    allRedacted.push(
      ...lensResult.disclosed.map(f => ({ fact: f, reasonCode: 'frame-not-authorized' })),
    )
    return {
      outcome: 'denied',
      disclosed: [],
      redacted: allRedacted,
      gatesEvaluated,
      reasonCode: 'frame-not-authorized',
    }
  }

  // Gate 4: HITL (request-level approval)
  const hitlResult = applyHitlGate(
    request.frame.requiresApproval,
    request.requestId,
    lensResult.disclosed,
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
    allRedacted.push(
      ...lensResult.disclosed.map(f => ({ fact: f, reasonCode: hitlResult.reasonCode! })),
    )
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
    disclosed: lensResult.disclosed,
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
  })
  const receipt = await signReceipt(unsigned, ctx.actorSecretKey)
  await ctx.store.append(receipt)
  return { result, receipt }
}
