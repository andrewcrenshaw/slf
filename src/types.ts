export type ScopeExpression =
  | { op: 'AND'; args: [ScopeExpression, ScopeExpression] }
  | { op: 'OR'; args: [ScopeExpression, ScopeExpression] }
  | { op: 'NOT'; arg: ScopeExpression }
  | { op: 'EQUALS'; field: string; value: unknown }
  | { op: 'WITHIN'; field: string; set: unknown[] }
  | { op: 'MATCHES'; field: string; pattern: string }

export interface Grant {
  id: string
  issuer: string
  audience: string
  grantType: 'read'
  scopeExpression: ScopeExpression
  allowedFrames: string[]
  validity: { iat: number; exp: number }
  /**
   * SP-3 (D1): the data subject the grant concerns, as a subject-controlled DID
   * (did:key/did:web). Bound into the signed payload. In the enterprise-held case
   * `issuer` is the enterprise and `subject` is the individual; in the inverted
   * (SP-4) case `issuer === subject`. Optional for backward compatibility — a grant
   * without it behaves exactly as before. When present it enables enforcement of
   * subject-authored gates (see AuthoredGate).
   */
  subject?: string
  signature?: string
}

/**
 * SP-3 (D2): a gate promoted from a bare tag string to a signed, attributable
 * policy object. Authored gates are RESTRICT-ONLY — the predicate names a
 * constraint, never a permission; permission always flows through the grant. A
 * restrict gate can only narrow disclosure, preserving the monotonic-narrowing
 * invariant. The signature is a compact JWS over the canonical gate
 * (id/author/predicate/validity), verifiable against `author`. `MATCHES`
 * predicates are disallowed (ReDoS — see design §6).
 */
export interface AuthoredGate {
  id: string
  /** DID of the gate author — an issuer OR a subject. */
  author: string
  predicate: ScopeExpression
  validity: { iat: number; exp: number }
  signature?: string
}

/**
 * SP-3 (D5): a signed tombstone retiring an AuthoredGate. The substrate treats a
 * validly-revoked gate as absent. Only the gate's author can revoke its own gate
 * — the signature is verifiable against `author`, which must match the gate's
 * `author`. Revoking a restrict gate widens access (the subject relaxing their
 * own constraint).
 */
export interface GateRevocation {
  gateId: string
  author: string
  iat: number
  signature?: string
}

export interface OkpPublicJwk {
  kty: 'OKP'
  crv: 'Ed25519'
  x: string
}

export interface KeyPair {
  did: string
  publicJwk: OkpPublicJwk
  secretKey: Uint8Array
}

export interface SubstrateReader {
  query(grant: Grant, fact: Record<string, unknown>): Promise<unknown[]>
}

export interface Lens {
  id: string
  role: string
  jurisdiction: string
  entityTypes: string[]
}

export interface Frame {
  id: string
  taskSlug: string
  intent: string
  nextStep: string
  requiresApproval: boolean
  allowedFrames: string[]
}

export type GateOutcome = 'granted' | 'denied' | 'partial' | 'pending_approval' | 'error'

export interface GateResult {
  outcome: GateOutcome
  reasonCode?: string
  disclosedFields?: string[]
  redactedFields?: string[]
  gatesEvaluated?: string[]
}

export interface Receipt {
  id: string
  grantRef: string
  outcome: GateOutcome
  reasonCode?: string
  disclosedFields?: string[]
  redactedFields?: string[]
  actorSignature?: string
  prevReceiptId?: string
  chainId?: string
  timestamp: number
}
