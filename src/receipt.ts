import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { signJWS, verifyJWS } from './signing.js'
import type { Receipt as BaseReceipt, GateOutcome, Grant } from './types.js'
import { DISCLOSURE_GOVERNING_GATES, type GateChainResult } from './gate-engine.js'
import { DEFAULT_ENFORCEMENT_TIER, type EnforcementTier } from './tier.js'

/**
 * A signed audit receipt for one gate-chain outcome.
 *
 * Extends the SLF-1 `Receipt` shape (types.ts) with `gatesEvaluated`, the
 * ordered list of gates the chain ran, and `enforcementTier`, the tier the
 * enforcer achieved (PROPOSAL-SLF §3). Every terminal outcome (granted | denied
 * | partial | error) emits exactly one of these — see gate-engine.ts.
 */
export interface Receipt extends BaseReceipt {
  gatesEvaluated?: string[]
  enforcementTier?: EnforcementTier
}

/**
 * The deterministic content the receipt id (hash-chain link) and the
 * actor_signature both commit to. Optional fields are normalised so rebuilding
 * the payload from a stored receipt is byte-stable. `enforcementTier` is part of
 * the signed payload, so a holder cannot relabel a T3 receipt as T0 after the
 * fact without invalidating the signature and breaking the hash chain.
 */
export interface ReceiptPayload {
  grantRef: string
  outcome: GateOutcome
  reasonCode: string | null
  disclosedFields: string[]
  redactedFields: string[]
  gatesEvaluated: string[]
  enforcementTier: EnforcementTier
  timestamp: number
}

/**
 * RFC-8785 (JCS) canonical JSON — recursive key-sorted serialization. Local
 * copy (mirrors signing.ts) so the hash-chain input and the signature-binding
 * check share one deterministic encoder.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const pairs = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    return '{' + pairs.join(',') + '}'
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`)
}

/** Sorted, de-duplicated union of the field names across a set of facts. */
function fieldNamesOf(facts: Array<Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const fact of facts) {
    for (const key of Object.keys(fact)) names.add(key)
  }
  return [...names].sort()
}

/** Normalise a receipt back to the deterministic payload used for hashing/signing. */
export function payloadOf(receipt: Receipt): ReceiptPayload {
  return {
    grantRef: receipt.grantRef,
    outcome: receipt.outcome,
    reasonCode: receipt.reasonCode ?? null,
    disclosedFields: receipt.disclosedFields ?? [],
    redactedFields: receipt.redactedFields ?? [],
    gatesEvaluated: receipt.gatesEvaluated ?? [],
    enforcementTier: receipt.enforcementTier ?? DEFAULT_ENFORCEMENT_TIER,
    timestamp: receipt.timestamp,
  }
}

/**
 * The hash-chain link: SHA256(prev_receipt_id || canonical(payload)), hex. This
 * value becomes the receipt's `id`, making receipts content-addressed and
 * tamper-evident.
 */
export function computeReceiptId(payload: ReceiptPayload, prevReceiptId?: string): string {
  const input = `${prevReceiptId ?? ''}${canonicalJson(payload)}`
  return bytesToHex(sha256(new TextEncoder().encode(input)))
}

/** The view the actor_signature commits to: content plus chain position. */
function signedView(receipt: Receipt): Record<string, unknown> {
  return { id: receipt.id, prevReceiptId: receipt.prevReceiptId ?? null, ...payloadOf(receipt) }
}

/**
 * Skip-evaluation detection (PROPOSAL-SLF §6.1). A receipt that names disclosed
 * fields but omits the disclosure-governing gates from `gatesEvaluated` is the
 * signature of a holder that released bytes WITHOUT honestly running the gate
 * chain. Disclosure with no governing gate is a forgery; returns true when one
 * is detected. A receipt that discloses nothing carries no honest-evaluation
 * obligation and is never flagged.
 */
export function detectSkipEvaluation(receipt: Receipt): boolean {
  const disclosed = receipt.disclosedFields ?? []
  if (disclosed.length === 0) return false
  const evaluated = new Set(receipt.gatesEvaluated ?? [])
  return DISCLOSURE_GOVERNING_GATES.some((gate) => !evaluated.has(gate))
}

export interface BuildReceiptOptions {
  timestamp: number
  prevReceiptId?: string
  chainId?: string
  /** Enforcement tier the producing principal achieved; defaults to T0 (Case A). */
  tier?: EnforcementTier
}

/**
 * Build an (unsigned) receipt from a gate-chain outcome. The receipt carries
 * outcome, reason_code, disclosed_fields, redacted_fields, gates_evaluated,
 * enforcement_tier and grant_ref; its id is the hash-chain link off
 * `prevReceiptId`.
 */
export function buildReceipt(
  chainResult: GateChainResult,
  grant: Pick<Grant, 'id'>,
  options: BuildReceiptOptions,
): Receipt {
  const payload: ReceiptPayload = {
    grantRef: grant.id,
    outcome: chainResult.outcome,
    reasonCode: chainResult.reasonCode ?? null,
    disclosedFields: fieldNamesOf(chainResult.disclosed),
    redactedFields: fieldNamesOf(chainResult.redacted.map((r) => r.fact)),
    gatesEvaluated: chainResult.gatesEvaluated ?? [],
    enforcementTier: options.tier ?? DEFAULT_ENFORCEMENT_TIER,
    timestamp: options.timestamp,
  }
  const id = computeReceiptId(payload, options.prevReceiptId)
  return {
    id,
    grantRef: payload.grantRef,
    outcome: payload.outcome,
    reasonCode: chainResult.reasonCode,
    disclosedFields: payload.disclosedFields,
    redactedFields: payload.redactedFields,
    gatesEvaluated: payload.gatesEvaluated,
    enforcementTier: payload.enforcementTier,
    timestamp: payload.timestamp,
    prevReceiptId: options.prevReceiptId,
    chainId: options.chainId ?? id,
  }
}

/** Sign a receipt with the actor's Ed25519 secret key (compact JWS). */
export async function signReceipt(receipt: Receipt, actorSecretKey: Uint8Array): Promise<Receipt> {
  const actorSignature = await signJWS(signedView(receipt), actorSecretKey)
  return { ...receipt, actorSignature }
}

/**
 * Verify a receipt's actor_signature AND that the signature is bound to the
 * receipt's current content (decode the signed payload and compare). Also
 * rejects a skip-evaluation forgery — a signature-valid receipt that discloses
 * fields without naming the gates that govern disclosure (§6.1). Returns false
 * on a tampered signature, a foreign key, any content mutation, or skip-eval.
 */
export async function verifyReceipt(receipt: Receipt, actorDid: string): Promise<boolean> {
  if (!receipt.actorSignature) return false
  if (!(await verifyJWS(receipt.actorSignature, actorDid))) return false

  const segments = receipt.actorSignature.split('.')
  if (segments.length !== 3) return false

  let signed: unknown
  try {
    signed = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
  } catch {
    return false
  }
  // both sides through the same canonical encoder -> order-independent equality
  if (canonicalJson(signed) !== canonicalJson(signedView(receipt))) return false

  // A correctly-signed receipt that discloses without honest evaluation is still invalid.
  if (detectSkipEvaluation(receipt)) return false

  return true
}
