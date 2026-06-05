import {
  buildSignedGrant,
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  type ConformanceCase,
} from '../harness.js'
import type { Frame, Lens } from '../../types.js'

/**
 * Case 6 — HITL approval pause-and-resume.
 * A frame that `requiresApproval` first returns `pending_approval` with no
 * receipt (a pause, not a terminal outcome). An `approve:` token completes the
 * read (granted); a `deny:` token denies it. Three reads, one grant, one human
 * in the loop.
 */
export const hitlApprovalCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-sensitive'

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

  // Step A — no token: the read pauses for review.
  const pending = await runGuardedRead(
    grant,
    { requestId: 'case-06', lens, frame },
    spyFetcher(facts),
    ctx,
  )

  // Step B — approval token: the read completes.
  const approved = await runGuardedRead(
    grant,
    { requestId: 'case-06', lens, frame, approvalToken: 'approve:case-06' },
    spyFetcher(facts),
    ctx,
  )

  // Step C — denial token: the read is denied.
  const denied = await runGuardedRead(
    grant,
    { requestId: 'case-06', lens, frame, approvalToken: 'deny:case-06' },
    spyFetcher(facts),
    ctx,
  )

  return makeCaseResult('06-hitl-approval', 'HITL frame pauses then resumes on an approval token', [
    { label: 'no token: outcome is pending_approval', ok: pending.result.outcome === 'pending_approval' },
    { label: 'no token: pause emits no receipt', ok: pending.receipt === null },
    { label: 'approval token completes the read (granted)', ok: approved.result.outcome === 'granted' },
    { label: 'approval discloses the sensitive fact', ok: approved.result.disclosed.length === 1 },
    { label: 'approval emits a granted receipt', ok: approved.receipt?.outcome === 'granted' },
    { label: 'denial token denies the read', ok: denied.result.outcome === 'denied' },
    { label: 'denial reason is approval-denied', ok: denied.result.reasonCode === 'approval-denied' },
  ])
}
