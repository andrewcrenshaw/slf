import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { signJWS, verifyJWS } from './signing.js'
import type { Receipt as BaseReceipt, GateOutcome, Grant } from './types.js'
import { DISCLOSURE_GOVERNING_GATES, type GateChainResult } from './gate-engine.js'
import { DEFAULT_ENFORCEMENT_TIER, type EnforcementTier } from './tier.js'

/**
 * The subject reference carried by a receipt whose data subject was not
 * specified at build time — e.g. the engine and erasure paths that do not yet
 * thread a data subject through {@link buildReceipt}. SP-1 requires every
 * receipt to CARRY a subject reference; a deployment activating subject
 * addressing threads a real subject via {@link BuildReceiptOptions.subjectRef}.
 */
export const UNSPECIFIED_SUBJECT = 'unspecified'

/**
 * A signed audit receipt for one gate-chain outcome.
 *
 * Extends the SLF-1 `Receipt` shape (types.ts) with `gatesEvaluated`, the
 * ordered list of gates the chain ran, `enforcementTier`, the tier the
 * enforcer achieved (PROPOSAL-SLF §3), and `subjectRef`, the data subject the
 * operation concerned (SP-1). Every terminal outcome (granted | denied |
 * partial | error) emits exactly one of these — see gate-engine.ts.
 */
export interface Receipt extends BaseReceipt {
  gatesEvaluated?: string[]
  enforcementTier?: EnforcementTier
  /** The data subject the operation concerned (SP-1); part of the signed payload. */
  subjectRef?: string
  /** The DID of the substrate custodian (SP-4 D5); equals the subject DID for read-in-place. */
  custodian?: string
}

/**
 * The deterministic content the receipt id (hash-chain link) and the
 * actor_signature both commit to. Optional fields are normalised so rebuilding
 * the payload from a stored receipt is byte-stable. `enforcementTier` is part of
 * the signed payload, so a holder cannot relabel a T3 receipt as T0 after the
 * fact without invalidating the signature and breaking the hash chain.
 * `subjectRef` is likewise signed, so the subject a receipt is addressed to
 * cannot be altered without breaking verification (SP-1).
 * `custodian` is signed when present (SP-4 D5), so a relay cannot strip it.
 */
export interface ReceiptPayload {
  grantRef: string
  subjectRef: string
  outcome: GateOutcome
  reasonCode: string | null
  disclosedFields: string[]
  redactedFields: string[]
  gatesEvaluated: string[]
  enforcementTier: EnforcementTier
  timestamp: number
  custodian?: string
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
  const base: ReceiptPayload = {
    grantRef: receipt.grantRef,
    subjectRef: receipt.subjectRef ?? UNSPECIFIED_SUBJECT,
    outcome: receipt.outcome,
    reasonCode: receipt.reasonCode ?? null,
    disclosedFields: receipt.disclosedFields ?? [],
    redactedFields: receipt.redactedFields ?? [],
    gatesEvaluated: receipt.gatesEvaluated ?? [],
    enforcementTier: receipt.enforcementTier ?? DEFAULT_ENFORCEMENT_TIER,
    timestamp: receipt.timestamp,
  }
  if (receipt.custodian !== undefined) base.custodian = receipt.custodian
  return base
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
  /**
   * The data subject the operation concerned (SP-1). Defaults to
   * {@link UNSPECIFIED_SUBJECT} for engine paths that do not yet thread a
   * subject; activate subject addressing by passing the subject's identifier.
   */
  subjectRef?: string
  /**
   * The DID of the substrate custodian (SP-4 D5). Set to the subject DID on the
   * read-in-place path; omitted on the standard issuer-held path.
   */
  custodian?: string
}

/**
 * Build an (unsigned) receipt from a gate-chain outcome. The receipt carries
 * outcome, reason_code, disclosed_fields, redacted_fields, gates_evaluated,
 * enforcement_tier, subject_ref and grant_ref; its id is the hash-chain link off
 * `prevReceiptId`.
 */
export function buildReceipt(
  chainResult: GateChainResult,
  grant: Pick<Grant, 'id'>,
  options: BuildReceiptOptions,
): Receipt {
  const payload: ReceiptPayload = {
    grantRef: grant.id,
    subjectRef: options.subjectRef ?? UNSPECIFIED_SUBJECT,
    outcome: chainResult.outcome,
    reasonCode: chainResult.reasonCode ?? null,
    disclosedFields: fieldNamesOf(chainResult.disclosed),
    redactedFields: fieldNamesOf(chainResult.redacted.map((r) => r.fact)),
    gatesEvaluated: chainResult.gatesEvaluated ?? [],
    enforcementTier: options.tier ?? DEFAULT_ENFORCEMENT_TIER,
    timestamp: options.timestamp,
  }
  if (options.custodian !== undefined) payload.custodian = options.custodian
  const id = computeReceiptId(payload, options.prevReceiptId)
  const receipt: Receipt = {
    id,
    grantRef: payload.grantRef,
    subjectRef: payload.subjectRef,
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
  if (payload.custodian !== undefined) receipt.custodian = payload.custodian
  return receipt
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

/**
 * A receipt copy addressed to its data subject (SP-1). It carries the issuer's
 * PUBLIC did and the already-signed receipt — nothing the issuer holds
 * privately — so a holder that does not trust the issuer can verify it from
 * public material alone via {@link verifySubjectAddressedReceipt}.
 */
export interface SubjectAddressedReceipt {
  /** The data subject this copy is addressed to; equals the signed receipt.subjectRef. */
  subjectRef: string
  /** The issuer's public did:key — the only key material a holder needs to verify. */
  issuerDid: string
  /** The signed, hash-chained receipt delivered to the subject. */
  receipt: Receipt
}

/**
 * Emit a subject-addressed copy of a signed receipt, for delivery to a recipient
 * other than the issuing party (SP-1). The copy reveals only the issuer's public
 * did alongside the already-signed receipt, so addressing a receipt to its
 * subject moves no secret. Throws on an unsigned receipt — there is nothing for a
 * third party to verify until the issuer has signed.
 */
export function emitSubjectAddressedReceipt(
  receipt: Receipt,
  issuerDid: string,
): SubjectAddressedReceipt {
  if (!receipt.actorSignature) {
    throw new Error('emitSubjectAddressedReceipt: receipt is unsigned')
  }
  return {
    subjectRef: receipt.subjectRef ?? UNSPECIFIED_SUBJECT,
    issuerDid,
    receipt,
  }
}

/** The gate evaluations a holder independently confirms from a verified copy. */
export interface VerifiedGateEvaluations {
  outcome: GateOutcome
  gatesEvaluated: string[]
  disclosedFields: string[]
  redactedFields: string[]
  enforcementTier: EnforcementTier
}

export interface SubjectVerification {
  /** true iff signature, subject-binding, and gate-evaluation integrity all hold. */
  verified: boolean
  /** Set when verification fails; identifies which check failed. */
  reason?: string
  /** The signed gate evaluations, returned only when verification holds. */
  gateEvaluations?: VerifiedGateEvaluations
}

/**
 * Verify a subject-addressed receipt copy AS A HOLDER that does not possess the
 * issuer's private keys (SP-1 third-party verifiability). Using only the public
 * did carried in the copy, it confirms:
 *  1. the actor signature is valid and bound to the receipt content — so the
 *     gate evaluations are exactly the ones the issuer signed,
 *  2. the envelope's subjectRef equals the signed subjectRef, so a copy cannot
 *     be re-addressed to a different subject without breaking the signature.
 * Returns the verified gate evaluations so the subject can read the provenance
 * the receipt records. Requires no secret the issuer holds.
 */
export async function verifySubjectAddressedReceipt(
  copy: SubjectAddressedReceipt,
): Promise<SubjectVerification> {
  if (!(await verifyReceipt(copy.receipt, copy.issuerDid))) {
    return { verified: false, reason: 'receipt-signature-invalid' }
  }
  const signedSubject = copy.receipt.subjectRef ?? UNSPECIFIED_SUBJECT
  if (copy.subjectRef !== signedSubject) {
    return { verified: false, reason: 'subject-binding-mismatch' }
  }
  return {
    verified: true,
    gateEvaluations: {
      outcome: copy.receipt.outcome,
      gatesEvaluated: copy.receipt.gatesEvaluated ?? [],
      disclosedFields: copy.receipt.disclosedFields ?? [],
      redactedFields: copy.receipt.redactedFields ?? [],
      enforcementTier: copy.receipt.enforcementTier ?? DEFAULT_ENFORCEMENT_TIER,
    },
  }
}
