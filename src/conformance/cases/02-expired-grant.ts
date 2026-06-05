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
 * Case 2 — Expired grant denies before any read.
 * The grant is correctly signed but its `validity.exp` is in the past, so it is
 * rejected at verification — the reader is never invoked — with a `denied`
 * receipt carrying reason `grant-expired`.
 */
export const expiredGrantCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-summary'

  const grant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: [frameId],
    iat: now - 7200,
    exp: now - 3600,
  })

  const lens: Lens = { id: 'lens-02', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-summary',
    intent: 'read facts',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameId],
  }
  const fetcher = spyFetcher([{ id: 'f1', entity_type: 'fact', content: 'a fact', domain: 'general' }])

  const { result, receipt, readerInvoked } = await runGuardedRead(
    grant,
    { requestId: 'case-02', lens, frame },
    fetcher,
    ctx,
  )

  return makeCaseResult('02-expired-grant', 'Expired grant is denied before any read', [
    { label: 'outcome is denied', ok: result.outcome === 'denied' },
    { label: 'reason code is grant-expired', ok: result.reasonCode === 'grant-expired' },
    {
      label: 'reader never invoked (rejected before read)',
      ok: readerInvoked === false && fetcher.invocations === 0,
    },
    { label: 'receipt outcome is denied', ok: receipt?.outcome === 'denied' },
  ])
}
