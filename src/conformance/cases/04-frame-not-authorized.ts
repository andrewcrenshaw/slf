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
 * Case 4 — Frame outside `allowed_frames` denies.
 * The grant is valid but the requested frame id is not in `grant.allowedFrames`,
 * so the frame check denies the read with reason `frame-not-authorized` and
 * nothing is disclosed.
 */
export const frameNotAuthorizedCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)

  const grant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: ['some-other-frame'],
    iat: now - 60,
    exp: now + 3600,
  })

  const lens: Lens = { id: 'lens-04', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: 'read-summary',
    taskSlug: 'read-summary',
    intent: 'read facts',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: ['read-summary'],
  }
  const fetcher = spyFetcher([{ id: 'f1', entity_type: 'fact', content: 'a fact', domain: 'general' }])

  const { result, receipt } = await runGuardedRead(
    grant,
    { requestId: 'case-04', lens, frame },
    fetcher,
    ctx,
  )

  return makeCaseResult(
    '04-frame-not-authorized',
    'Read through a frame outside allowed_frames is denied',
    [
      { label: 'outcome is denied', ok: result.outcome === 'denied' },
      { label: 'reason code is frame-not-authorized', ok: result.reasonCode === 'frame-not-authorized' },
      { label: 'nothing disclosed', ok: result.disclosed.length === 0 },
      { label: 'receipt outcome is denied', ok: receipt?.outcome === 'denied' },
    ],
  )
}
