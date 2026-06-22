import type {
  AuthoredGate,
  GateRevocation,
  Grant,
  ScopeExpression,
} from './types.js'
import { signJWS, verifyJWS } from './signing.js'

export function createGrant(params: {
  issuer: string
  audience: string
  scopeExpression: ScopeExpression
  allowedFrames: string[]
  validity: { iat: number; exp: number }
  /** SP-3 (D1): subject-controlled DID the grant concerns. Optional. */
  subject?: string
}): Grant {
  const grant: Grant = {
    id: crypto.randomUUID(),
    issuer: params.issuer,
    audience: params.audience,
    grantType: 'read',
    scopeExpression: params.scopeExpression,
    allowedFrames: params.allowedFrames,
    validity: params.validity,
  }
  // Only attach the subject seat when present — an explicit `undefined` would
  // become an unsignable key in the canonical JWS payload.
  if (params.subject !== undefined) grant.subject = params.subject
  return grant
}

export async function signGrant(grant: Grant, secretKey: Uint8Array): Promise<Grant> {
  const { signature: _sig, ...payload } = grant
  const jws = await signJWS(payload as Record<string, unknown>, secretKey)
  return { ...grant, signature: jws }
}

export async function verifyGrant(
  grant: Grant,
): Promise<{ valid: boolean; reason?: string }> {
  const now = Math.floor(Date.now() / 1000)

  if (grant.validity.exp < now) {
    return { valid: false, reason: 'grant-expired' }
  }

  if (!grant.signature) {
    return { valid: false, reason: 'no-signature' }
  }

  const valid = await verifyJWS(grant.signature, grant.issuer)
  return valid ? { valid: true } : { valid: false, reason: 'invalid-signature' }
}

// ── SP-3: individual-controlled identity anchoring ──────────────────────────
//
// Authored gates (D2/D3), gate revocation (D5), and consumer binding (D4) live
// here so the identity-anchoring primitives sit alongside the grant they bind.
// All three reuse the Ed25519 JWS path (signing.ts): a gate or token is honored
// only when its signature verifies against the DID that claims authorship, which
// is what makes "the individual sets the gate" cryptographically true rather than
// a convention.

/** Recursively true iff a scope expression uses the MATCHES op. */
function predicateUsesMatches(expr: ScopeExpression): boolean {
  switch (expr.op) {
    case 'AND':
    case 'OR':
      return predicateUsesMatches(expr.args[0]) || predicateUsesMatches(expr.args[1])
    case 'NOT':
      return predicateUsesMatches(expr.arg)
    case 'MATCHES':
      return true
    default:
      return false
  }
}

/** Order-independent structural equality for signed-payload binding checks. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    if (ak.length !== bk.length) return false
    return ak.every(
      (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]),
    )
  }
  return false
}

/** Decode the (already signature-verified) payload segment of a compact JWS. */
function decodeJwsPayload(jws: string): unknown {
  const seg = jws.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf-8'))
}

function authoredGatePayload(gate: AuthoredGate): Record<string, unknown> {
  return { id: gate.id, author: gate.author, predicate: gate.predicate, validity: gate.validity }
}

function revocationPayload(rev: GateRevocation): Record<string, unknown> {
  return { gateId: rev.gateId, author: rev.author, iat: rev.iat }
}

/**
 * Sign a restrict-only authored gate against its author's key. A MATCHES
 * predicate is rejected at authoring time — a subject-authored predicate is
 * untrusted, and a regex predicate is a ReDoS vector against the evaluating
 * engine (design §6). EQUALS/WITHIN/AND/OR/NOT stay decidable.
 */
export async function signAuthoredGate(
  gate: AuthoredGate,
  secretKey: Uint8Array,
): Promise<AuthoredGate> {
  if (predicateUsesMatches(gate.predicate)) {
    throw new Error('authored-gate: MATCHES predicate is disallowed (ReDoS)')
  }
  const jws = await signJWS(authoredGatePayload(gate), secretKey)
  return { ...gate, signature: jws }
}

/**
 * An authored gate is honored only when it is signed by its author, unexpired,
 * MATCHES-free, and the signature binds the gate's current fields. Anything else
 * — unsigned, forged, expired, tampered, or MATCHES — returns false and is
 * ignored by the engine; a restrict gate is never honored on weak evidence.
 */
export async function verifyAuthoredGate(gate: AuthoredGate): Promise<boolean> {
  if (!gate.signature) return false
  if (predicateUsesMatches(gate.predicate)) return false
  const now = Math.floor(Date.now() / 1000)
  if (typeof gate.validity?.exp !== 'number' || gate.validity.exp < now) return false
  if (!(await verifyJWS(gate.signature, gate.author))) return false
  return deepEqual(decodeJwsPayload(gate.signature), authoredGatePayload(gate))
}

/** Sign a gate revocation (tombstone) against the revoking author's key. */
export async function signGateRevocation(
  rev: GateRevocation,
  secretKey: Uint8Array,
): Promise<GateRevocation> {
  const jws = await signJWS(revocationPayload(rev), secretKey)
  return { ...rev, signature: jws }
}

/**
 * A revocation is valid only when signed by the DID it names as `author` and the
 * signature binds its current fields. The engine additionally requires that
 * `author` match the gate's own author before treating the gate as absent, so a
 * third party cannot revoke another party's gate even with a self-consistent
 * tombstone.
 */
export async function verifyGateRevocation(rev: GateRevocation): Promise<boolean> {
  if (!rev.signature) return false
  if (!(await verifyJWS(rev.signature, rev.author))) return false
  return deepEqual(decodeJwsPayload(rev.signature), revocationPayload(rev))
}

/** Sign a consumer request token binding a requestId to the holder's DID (D4). */
export async function signConsumerRequest(
  params: { requestId: string; holderDid: string },
  secretKey: Uint8Array,
): Promise<string> {
  return signJWS({ requestId: params.requestId, holderDid: params.holderDid }, secretKey)
}

/**
 * Verify a consumer request token proves the reader controls `holderDid` for this
 * exact `requestId`. Closes the anyone-can-replay-a-grant gap: a token signed by
 * a different key, or bound to a different request/holder, fails.
 */
export async function verifyConsumerRequest(
  token: string | undefined,
  holderDid: string,
  requestId: string,
): Promise<boolean> {
  if (!token) return false
  if (!(await verifyJWS(token, holderDid))) return false
  try {
    const claims = decodeJwsPayload(token) as { requestId?: unknown; holderDid?: unknown }
    return claims.requestId === requestId && claims.holderDid === holderDid
  } catch {
    return false
  }
}

function isAuthoredGate(x: unknown): x is AuthoredGate {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as AuthoredGate).id === 'string' &&
    typeof (x as AuthoredGate).author === 'string' &&
    typeof (x as AuthoredGate).predicate === 'object' &&
    (x as AuthoredGate).predicate !== null
  )
}

/** Pull the structured authored gates out of a fact's mixed `gates` field. */
function extractAuthoredGates(gates: unknown): AuthoredGate[] {
  if (Array.isArray(gates)) return gates.filter(isAuthoredGate)
  if (isAuthoredGate(gates)) return [gates]
  return []
}

function extractRevocations(revocations: unknown): GateRevocation[] {
  return Array.isArray(revocations)
    ? (revocations.filter(
        (r) =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as GateRevocation).gateId === 'string' &&
          typeof (r as GateRevocation).author === 'string',
      ) as GateRevocation[])
    : []
}

/**
 * Conservative entailment: does the grant's scope guarantee the gate predicate?
 * True only when the predicate is asserted conjunctively by the grant (deep-equal
 * to the scope or to a branch reachable through AND). OR/NOT branches cannot
 * guarantee it, so they return false — the check is sound (never a false
 * "satisfies"), which keeps a restrict gate from being bypassed.
 */
function grantSatisfiesPredicate(scope: ScopeExpression, predicate: ScopeExpression): boolean {
  if (deepEqual(scope, predicate)) return true
  if (scope.op === 'AND') {
    return (
      grantSatisfiesPredicate(scope.args[0], predicate) ||
      grantSatisfiesPredicate(scope.args[1], predicate)
    )
  }
  return false
}

export interface AuthoredGateResult {
  pass: boolean
  reasonCode?: string
}

/**
 * SP-3 (D3): evaluate the subject-authored restrict gates on a fact against the
 * grant. A valid, unrevoked gate authored by `grant.subject` excludes the fact
 * unless the grant's scope satisfies the gate's predicate — monotonic narrowing
 * extended to subject authority (disclosed = grant-scope INTERSECT subject-gates).
 * An enterprise read grant cannot bypass a subject restrict gate. Grants without
 * a subject seat, and facts without authored gates, pass unchanged.
 */
export async function evaluateAuthoredGates(
  grant: Grant,
  fact: Record<string, unknown>,
): Promise<AuthoredGateResult> {
  if (!grant.subject) return { pass: true }
  const gates = extractAuthoredGates(fact.gates)
  if (gates.length === 0) return { pass: true }

  const revoked = new Set<string>()
  for (const rev of extractRevocations(fact.gateRevocations)) {
    if (await verifyGateRevocation(rev)) revoked.add(`${rev.gateId}::${rev.author}`)
  }

  for (const gate of gates) {
    if (gate.author !== grant.subject) continue
    if (revoked.has(`${gate.id}::${gate.author}`)) continue
    if (!(await verifyAuthoredGate(gate))) continue
    if (!grantSatisfiesPredicate(grant.scopeExpression, gate.predicate)) {
      return { pass: false, reasonCode: 'subject-gate-restricted' }
    }
  }
  return { pass: true }
}
