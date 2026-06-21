import {
  buildSignedGrant,
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  type ConformanceCase,
} from '../harness.js'
import { generateKeyPair } from '../../did-key.js'
import { applyHitlGate, signApprovalToken } from '../../gates/hitl-gate.js'
import type { Frame, Lens } from '../../types.js'

/**
 * Case 6 — HITL approval is authenticated (PCC-3119).
 * A frame that `requiresApproval` first returns `pending_approval` with no receipt
 * (a pause, not a terminal outcome). It resumes ONLY on a token minted by
 * `signApprovalToken`: a signature from an approver did:key, bound to this
 * `requestId`, and unexpired. The pre-PCC-3119 bypass — any string starting with
 * `approve:` — is rejected: a bare `approve:`, the old unsigned `approve:<id>`,
 * a token bound to another request, an expired token, a forged signature, and an
 * untrusted approver all pause for a human instead of disclosing. A `deny:` token
 * denies. One grant, one human in the loop, no forgeable approvals.
 */
export const hitlApprovalCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-sensitive'
  const requestId = 'case-06'

  const grant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: [frameId],
    iat: now - 60,
    exp: now + 3600,
  })

  const lens: Lens = { id: 'lens-06', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-sensitive',
    intent: 'read sensitive facts',
    nextStep: 'await-approval',
    requiresApproval: true,
    allowedFrames: [frameId],
  }
  const facts = [{ id: 'f1', entity_type: 'fact', content: 'sensitive fact', domain: 'general' }]

  // The authorized approver and a token validly signed + bound to this request.
  const approver = generateKeyPair()
  const validToken = signApprovalToken(
    { requestId, approver: approver.did, iat: now - 10, exp: now + 600 },
    approver.secretKey,
  )

  // Step A — no token: the read pauses for review.
  const pending = await runGuardedRead(grant, { requestId, lens, frame }, spyFetcher(facts), ctx)

  // Step B — a valid signed approval: the read completes.
  const approved = await runGuardedRead(
    grant,
    { requestId, lens, frame, approvalToken: validToken },
    spyFetcher(facts),
    ctx,
  )

  // Step C — denial token: the read is denied (fail-safe, no auth required).
  const denied = await runGuardedRead(
    grant,
    { requestId, lens, frame, approvalToken: 'deny:case-06' },
    spyFetcher(facts),
    ctx,
  )

  // Step D — the pre-PCC-3119 bypass: a bare 'approve:' string. Must not disclose.
  const bypass = await runGuardedRead(
    grant,
    { requestId, lens, frame, approvalToken: 'approve:' },
    spyFetcher(facts),
    ctx,
  )

  // Step E — the old unsigned 'approve:<id>' form must also be rejected now.
  const legacyBypass = await runGuardedRead(
    grant,
    { requestId, lens, frame, approvalToken: 'approve:case-06' },
    spyFetcher(facts),
    ctx,
  )

  // Direct gate checks for the binding / expiry / signature / trust properties.
  const sample = [{ id: 'f1', entity_type: 'fact' }]

  // requestId binding: a token validly signed for a DIFFERENT request is rejected.
  const wrongRequest = applyHitlGate(
    true,
    requestId,
    sample,
    signApprovalToken(
      { requestId: 'some-other-request', approver: approver.did, iat: now - 10, exp: now + 600 },
      approver.secretKey,
    ),
  )

  // expiry: a validly signed, correctly-bound, but expired token is rejected.
  const expired = applyHitlGate(
    true,
    requestId,
    sample,
    signApprovalToken(
      { requestId, approver: approver.did, iat: now - 7200, exp: now - 3600 },
      approver.secretKey,
    ),
  )

  // signature: a token claiming `approver` but signed by a different key is rejected
  // (an impersonation attempt — the claimed DID does not own the signing key).
  const intruder = generateKeyPair()
  const forgedSig = applyHitlGate(
    true,
    requestId,
    sample,
    signApprovalToken(
      { requestId, approver: approver.did, iat: now - 10, exp: now + 600 },
      intruder.secretKey,
    ),
  )

  // trusted-approver allowlist: an untrusted approver is rejected; the trusted one passes.
  const untrusted = applyHitlGate(
    true,
    requestId,
    sample,
    signApprovalToken(
      { requestId, approver: intruder.did, iat: now - 10, exp: now + 600 },
      intruder.secretKey,
    ),
    [approver.did],
  )
  const trusted = applyHitlGate(true, requestId, sample, validToken, [approver.did])

  return makeCaseResult(
    '06-hitl-approval',
    'HITL approval token is authenticated (signed, request-bound, expiring)',
    [
      { label: 'no token: outcome is pending_approval', ok: pending.result.outcome === 'pending_approval' },
      { label: 'no token: pause emits no receipt', ok: pending.receipt === null },
      { label: 'valid signed token completes the read (granted)', ok: approved.result.outcome === 'granted' },
      { label: 'valid approval discloses the sensitive fact', ok: approved.result.disclosed.length === 1 },
      { label: 'valid approval emits a granted receipt', ok: approved.receipt?.outcome === 'granted' },
      { label: 'denial token denies the read', ok: denied.result.outcome === 'denied' },
      { label: 'denial reason is approval-denied', ok: denied.result.reasonCode === 'approval-denied' },
      { label: "bare 'approve:' bypass does not grant", ok: bypass.result.outcome !== 'granted' },
      { label: "bare 'approve:' bypass discloses nothing", ok: bypass.result.disclosed.length === 0 },
      { label: "bare 'approve:' bypass emits no receipt", ok: bypass.receipt === null },
      { label: "legacy unsigned 'approve:<id>' does not grant", ok: legacyBypass.result.outcome !== 'granted' },
      { label: 'token bound to another requestId is rejected', ok: wrongRequest.outcome !== 'pass' && wrongRequest.reasonCode === 'approval-request-mismatch' },
      { label: 'expired-but-signed token is rejected', ok: expired.outcome !== 'pass' && expired.reasonCode === 'approval-expired' },
      { label: 'forged-signature token is rejected', ok: forgedSig.outcome !== 'pass' && forgedSig.reasonCode === 'approval-signature-invalid' },
      { label: 'untrusted approver rejected when allowlist enforced', ok: untrusted.outcome !== 'pass' && untrusted.reasonCode === 'approver-not-trusted' },
      { label: 'trusted approver passes when allowlist enforced', ok: trusted.outcome === 'pass' },
    ],
  )
}
