import { makeCaseResult, newCaseContext, type ConformanceCase } from '../harness.js'
import { buildReceipt, signReceipt, verifyReceipt } from '../../receipt.js'
import { receiptSupportsTierClaim } from '../../tier.js'
import type { GateChainResult } from '../../gate-engine.js'

/**
 * Case 9 — Tier label is carried and checked (PROPOSAL-SLF §3 / §6).
 * Two receipts over identical content are produced under different enforcement
 * tiers. The tier is descriptive of the enforcer, not a self-asserted upgrade:
 * a T3 (accountability-only) receipt cannot substantiate a T0/T2 prevention
 * claim, and relabeling a signed T3 receipt as T0 breaks its verification.
 */
export const tierClaimMismatchCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const grantRef = { id: 'grant-tier' }
  const timestamp = ctx.now!()

  const result: GateChainResult = {
    outcome: 'granted',
    disclosed: [{ entity_type: 'fact', text: 'x' }],
    redacted: [],
    gatesEvaluated: ['substrate-gate', 'lens-projection', 'frame-check', 'hitl-gate'],
  }

  const t0 = await signReceipt(
    buildReceipt(result, grantRef, { timestamp, tier: 'T0' }),
    actor.secretKey,
  )
  const t3 = await signReceipt(
    buildReceipt(result, grantRef, { timestamp, tier: 'T3' }),
    actor.secretKey,
  )

  // Self-assertion upgrade attempt: relabel a T3 receipt as T0 without re-signing.
  const upgraded = { ...t3, enforcementTier: 'T0' as const }
  const upgradeVerifies = await verifyReceipt(upgraded, actor.did)

  return makeCaseResult(
    '09-tier-claim-mismatch',
    'A receipt cannot claim a stronger enforcement tier than it was produced under',
    [
      { label: 'receipt carries its enforcement tier label', ok: t0.enforcementTier === 'T0' && t3.enforcementTier === 'T3' },
      { label: 'T0 receipt substantiates a T0 (prevention) claim', ok: receiptSupportsTierClaim(t0.enforcementTier!, 'T0') === true },
      { label: 'T3 receipt CANNOT claim a T0 prevention guarantee', ok: receiptSupportsTierClaim(t3.enforcementTier!, 'T0') === false },
      { label: 'T3 receipt CANNOT claim a T2 guarantee', ok: receiptSupportsTierClaim(t3.enforcementTier!, 'T2') === false },
      { label: 'T3 receipt may still substantiate a T3 (accountability) claim', ok: receiptSupportsTierClaim(t3.enforcementTier!, 'T3') === true },
      { label: 'tier is signed: relabeling T3->T0 breaks verification', ok: upgradeVerifies === false },
    ],
  )
}
