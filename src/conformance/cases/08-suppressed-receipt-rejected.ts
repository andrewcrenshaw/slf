import {
  buildSignedGrant,
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  tamperSignature,
  type ConformanceCase,
} from '../harness.js'
import { acceptDisclosure } from '../../consume.js'
import type { Frame, Lens } from '../../types.js'

/**
 * Case 8 — Suppressed receipt → rejected disclosure (PROPOSAL-SLF §4.1 / §6).
 * A real guarded read yields disclosed data plus a valid receipt. The relying
 * side accepts the data only when the receipt rides along: a suppressed
 * (missing) receipt and a tampered receipt are both refused. Suppression costs
 * the discloser the transaction.
 */
export const suppressedReceiptRejectedCase: ConformanceCase = async () => {
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

  const lens: Lens = { id: 'lens-08', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-summary',
    intent: 'read facts',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameId],
  }
  const facts = [{ id: 'f1', entity_type: 'fact', content: 'disclosed payload', domain: 'general' }]

  const { result, receipt } = await runGuardedRead(
    grant,
    { requestId: 'case-08', lens, frame },
    spyFetcher(facts),
    ctx,
  )

  // Data WITH a valid receipt -> accepted.
  const withReceipt = await acceptDisclosure(
    { receipt, data: result.disclosed },
    { actorDid: actor.did },
  )

  // Suppressed (missing) receipt -> refused.
  const suppressed = await acceptDisclosure(
    { receipt: null, data: result.disclosed },
    { actorDid: actor.did },
  )

  // Tampered receipt -> refused as invalid.
  const tampered = receipt?.actorSignature
    ? { ...receipt, actorSignature: tamperSignature(receipt.actorSignature) }
    : null
  const tamperedResult = await acceptDisclosure(
    { receipt: tampered, data: result.disclosed },
    { actorDid: actor.did },
  )

  return makeCaseResult(
    '08-suppressed-receipt-rejected',
    'The relying side refuses disclosed data that lacks a valid receipt',
    [
      { label: 'read produced a verifiable receipt', ok: receipt !== null },
      { label: 'data WITH a valid receipt is accepted', ok: withReceipt.accepted === true },
      {
        label: 'suppressed (missing) receipt: disclosure refused as no-receipt',
        ok: suppressed.accepted === false && suppressed.reasonCode === 'no-receipt',
      },
      {
        label: 'tampered receipt: disclosure refused as invalid-receipt',
        ok: tamperedResult.accepted === false && tamperedResult.reasonCode === 'invalid-receipt',
      },
    ],
  )
}
