import {
  buildSignedGrant,
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  verifyReceipt,
  type ConformanceCase,
} from '../harness.js'
import type { Frame, Lens } from '../../types.js'

/**
 * Case 1 — Valid grant permits an in-scope read.
 * A signed, in-window grant scoped to `entity_type=fact` discloses exactly the
 * matching row and emits a verifiable `granted` receipt.
 */
export const validGrantCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-summary'

  const grant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: [frameId],
    iat: now - 60,
    exp: now + 3600,
  })

  const lens: Lens = { id: 'lens-01', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-summary',
    intent: 'read facts',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameId],
  }
  const fetcher = spyFetcher([
    { id: 'f1', entity_type: 'fact', content: 'a valid fact', domain: 'general' },
    { id: 'c1', entity_type: 'claim', content: 'a claim', domain: 'general' },
  ])

  const { result, receipt, readerInvoked } = await runGuardedRead(
    grant,
    { requestId: 'case-01', lens, frame },
    fetcher,
    ctx,
  )
  const verified = receipt ? await verifyReceipt(receipt, actor.did) : false

  return makeCaseResult(
    '01-valid-grant',
    'Valid grant permits an in-scope read and emits a granted receipt',
    [
      { label: 'reader invoked under a valid grant', ok: readerInvoked === true },
      { label: 'outcome is granted', ok: result.outcome === 'granted' },
      {
        label: 'discloses only the in-scope fact',
        ok: result.disclosed.length === 1 && result.disclosed[0].id === 'f1',
      },
      { label: 'receipt outcome is granted', ok: receipt?.outcome === 'granted' },
      { label: 'receipt signature verifies against the actor DID', ok: verified },
    ],
  )
}
