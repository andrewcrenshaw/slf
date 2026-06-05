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
 * Case 3 — Gate-restricted fact is redacted.
 * Two in-scope facts are fetched; one carries a `health-data` gate tag the grant
 * does not authorize. The clean fact discloses, the tagged fact is redacted with
 * reason `gate-tag-restricted`, and the receipt records the redacted field names.
 */
export const gateRedactionCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-summary'

  // Scope references entity_type only — NOT the `gates` field — so a restrictive
  // gate tag triggers redaction.
  const grant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: [frameId],
    iat: now - 60,
    exp: now + 3600,
  })

  const lens: Lens = { id: 'lens-03', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-summary',
    intent: 'read facts',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameId],
  }
  const fetcher = spyFetcher([
    { id: 'clean', entity_type: 'fact', content: 'public', domain: 'general', gates: [] },
    { id: 'phi', entity_type: 'fact', content: 'sensitive', domain: 'general', gates: ['health-data'] },
  ])

  const { result, receipt } = await runGuardedRead(
    grant,
    { requestId: 'case-03', lens, frame },
    fetcher,
    ctx,
  )

  const redactedPhi = result.redacted.find((r) => r.fact.id === 'phi')
  const redactedFields = receipt?.redactedFields ?? []

  return makeCaseResult('03-gate-redaction', 'Gate-restricted fact is redacted and recorded', [
    { label: 'outcome is granted', ok: result.outcome === 'granted' },
    { label: 'clean fact disclosed', ok: result.disclosed.some((f) => f.id === 'clean') },
    { label: 'health-data fact redacted', ok: redactedPhi !== undefined },
    { label: 'redaction reason is gate-tag-restricted', ok: redactedPhi?.reasonCode === 'gate-tag-restricted' },
    {
      label: 'receipt records redacted fields',
      ok: redactedFields.length > 0 && redactedFields.includes('gates'),
    },
  ])
}
