import {
  buildSignedGrant,
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  tamperSignature,
  type ConformanceCase,
} from '../harness.js'
import type { Frame, Lens } from '../../types.js'

/**
 * Case 5 — Tampered grant fails before any read.
 * The grant is signed correctly, then one byte of its signature is flipped.
 * Verification fails, the read short-circuits to `outcome:error`, and — the load
 * bearing assertion — the SubstrateReader is NEVER invoked. A tampered grant
 * cannot cause a single fact to be fetched.
 */
export const tamperedGrantCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-summary'

  const signed = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: [frameId],
    iat: now - 60,
    exp: now + 3600,
  })
  const tampered = { ...signed, signature: tamperSignature(signed.signature ?? '') }

  const lens: Lens = { id: 'lens-05', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
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
    tampered,
    { requestId: 'case-05', lens, frame },
    fetcher,
    ctx,
  )

  return makeCaseResult('05-tampered-grant', 'Tampered grant fails verification before any read', [
    { label: 'signature was actually altered', ok: tampered.signature !== signed.signature },
    { label: 'outcome is error', ok: result.outcome === 'error' },
    { label: 'reason code is invalid-signature', ok: result.reasonCode === 'invalid-signature' },
    { label: 'reader never invoked on a tampered grant', ok: readerInvoked === false && fetcher.invocations === 0 },
    { label: 'receipt outcome is error', ok: receipt?.outcome === 'error' },
  ])
}
