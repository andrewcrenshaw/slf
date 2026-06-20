import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { decodeDid } from '../did-key.js'

// Enable synchronous Ed25519 (idempotent). The HITL gate is invoked synchronously
// and unawaited from gate-engine.ts, so approval verification must be sync too —
// we use @noble/ed25519's sync API rather than the async `jose` path used elsewhere.
if (!ed.utils.sha512Sync) {
  ed.utils.sha512Sync = (...m: Uint8Array[]) => sha512(Buffer.concat(m))
}

export type HitlOutcome = 'pass' | 'pending_approval' | 'denied'

export interface HitlGateResult {
  outcome: HitlOutcome
  disclosurePreview?: string
  reasonCode?: string
}

/**
 * The claims an approval token binds and signs. The signature is over the
 * canonical serialization of exactly these fields, so an approval cannot be
 * replayed against a different request (`requestId`) or used after it lapses
 * (`exp`), and its origin is the `approver` did:key.
 */
export interface ApprovalClaims {
  /** The frame requestId this approval authorizes — binds the token to one request. */
  requestId: string
  /** did:key of the approver whose secret key signed the token. */
  approver: string
  /** Issued-at, unix seconds. */
  iat: number
  /** Expiry, unix seconds — the gate rejects the token once now exceeds it. */
  exp: number
}

interface ApprovalEnvelope extends ApprovalClaims {
  /** base64url Ed25519 signature over the canonical claims. */
  sig: string
}

const APPROVAL_PREFIX = 'approve:'
const DENIAL_PREFIX = 'deny:'

/**
 * Deterministic, key-sorted serialization of the signed claims. Mint and verify
 * MUST produce identical bytes; the replacer-array form fixes both the key set
 * and the key order regardless of insertion order.
 */
function canonicalClaims(claims: ApprovalClaims): Uint8Array {
  const json = JSON.stringify(claims, ['approver', 'exp', 'iat', 'requestId'])
  return new TextEncoder().encode(json)
}

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Mint a signed approval token. `approver` MUST be the did:key for `secretKey`.
 * The returned string is what a caller passes to `applyHitlGate` as
 * `approvalToken`. This is the only supported way to produce a token the gate
 * will honour — a bare `approve:` prefix is no longer sufficient (PCC-3119).
 */
export function signApprovalToken(claims: ApprovalClaims, secretKey: Uint8Array): string {
  const sig = ed.sync.sign(canonicalClaims(claims), secretKey)
  const envelope: ApprovalEnvelope = { ...claims, sig: b64urlEncode(sig) }
  return APPROVAL_PREFIX + b64urlEncode(new TextEncoder().encode(JSON.stringify(envelope)))
}

/** Parse and structurally validate an approval envelope; null if malformed. */
function parseApprovalEnvelope(token: string): ApprovalEnvelope | null {
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(token.slice(APPROVAL_PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.requestId !== 'string' ||
    typeof o.approver !== 'string' ||
    typeof o.iat !== 'number' ||
    typeof o.exp !== 'number' ||
    typeof o.sig !== 'string'
  ) {
    return null
  }
  return { requestId: o.requestId, approver: o.approver, iat: o.iat, exp: o.exp, sig: o.sig }
}

/** Verify the envelope signature against the public key encoded in its approver DID. */
function approvalSignatureValid(env: ApprovalEnvelope): boolean {
  try {
    const publicKey = decodeDid(env.approver)
    const claims: ApprovalClaims = {
      requestId: env.requestId,
      approver: env.approver,
      iat: env.iat,
      exp: env.exp,
    }
    return ed.sync.verify(Buffer.from(env.sig, 'base64url'), canonicalClaims(claims), publicKey)
  } catch {
    return false
  }
}

/** A failed approval pauses for a real human; it never discloses. */
function pendingApproval(requestId: string, reasonCode: string): HitlGateResult {
  return {
    outcome: 'pending_approval',
    reasonCode,
    disclosurePreview: `unverifiable approval token for request ${requestId} (${reasonCode})`,
  }
}

/**
 * Authenticate an `approve:`-prefixed token. It passes only when its signature
 * verifies against the approver DID, its `requestId` matches this request, and it
 * has not expired. When `trustedApprovers` is supplied the approver DID must also
 * be a member — see THREAT_MODEL.md for the residual trust assumption when it is
 * omitted (a self-asserted DID still produces a structurally valid signature).
 */
function verifyApproval(
  approvalToken: string,
  requestId: string,
  trustedApprovers?: ReadonlyArray<string>,
): HitlGateResult {
  const env = parseApprovalEnvelope(approvalToken)
  if (!env) return pendingApproval(requestId, 'approval-malformed')
  if (!approvalSignatureValid(env)) return pendingApproval(requestId, 'approval-signature-invalid')
  if (env.requestId !== requestId) return pendingApproval(requestId, 'approval-request-mismatch')
  if (env.exp < Math.floor(Date.now() / 1000)) return pendingApproval(requestId, 'approval-expired')
  if (trustedApprovers && !trustedApprovers.includes(env.approver)) {
    return pendingApproval(requestId, 'approver-not-trusted')
  }
  return { outcome: 'pass' }
}

/**
 * The HITL gate. A frame that `requiresApproval` discloses nothing until a valid
 * approval token resumes the read.
 *
 * Security (PCC-3119): an approval token is a signed, request-bound, expiring
 * artifact minted by `signApprovalToken`. The pre-PCC-3119 behaviour — any string
 * starting with `approve:` passed — is fixed: every unauthenticated, mis-bound, or
 * expired token now pauses for a human instead of disclosing. An explicit `deny:`
 * is fail-safe and withholds disclosure without needing authentication.
 */
export function applyHitlGate(
  requiresApproval: boolean,
  requestId: string,
  disclosed: Array<Record<string, unknown>>,
  approvalToken?: string,
  trustedApprovers?: ReadonlyArray<string>,
): HitlGateResult {
  if (!requiresApproval) {
    return { outcome: 'pass' }
  }

  if (!approvalToken) {
    return {
      outcome: 'pending_approval',
      disclosurePreview: `${disclosed.length} fact(s) pending review for request ${requestId}`,
    }
  }

  if (approvalToken.startsWith(DENIAL_PREFIX)) {
    return { outcome: 'denied', reasonCode: 'approval-denied' }
  }

  if (approvalToken.startsWith(APPROVAL_PREFIX)) {
    return verifyApproval(approvalToken, requestId, trustedApprovers)
  }

  return {
    outcome: 'pending_approval',
    disclosurePreview: `invalid approval token for request ${requestId}`,
  }
}
