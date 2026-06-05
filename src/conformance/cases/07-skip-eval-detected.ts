import { makeCaseResult, newCaseContext, type ConformanceCase } from '../harness.js'
import { buildReceipt, detectSkipEvaluation, signReceipt, verifyReceipt } from '../../receipt.js'
import type { GateChainResult } from '../../gate-engine.js'

/**
 * Case 7 — Skip-evaluation is detectable at the receipt layer (PROPOSAL-SLF §6.1).
 * A hostile holder discloses fields but never honestly ran the gate chain. Both
 * the honest receipt and the forgery are signed by a valid actor key, so the
 * signature alone cannot tell them apart — but the forgery names disclosed
 * fields with NO governing gates evaluated, and so fails verification.
 */
export const skipEvalDetectedCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const grantRef = { id: 'grant-skip-eval' }
  const timestamp = ctx.now!()
  const disclosed = [{ entity_type: 'fact', text: 'public' }]

  // Honest read: the gate chain actually ran -> governing gates present.
  const honestResult: GateChainResult = {
    outcome: 'granted',
    disclosed,
    redacted: [],
    gatesEvaluated: ['substrate-gate', 'lens-projection', 'frame-check', 'hitl-gate'],
  }
  const honest = await signReceipt(
    buildReceipt(honestResult, grantRef, { timestamp }),
    actor.secretKey,
  )

  // Skip-eval forgery: the holder discloses the SAME fields but names NO gates
  // as evaluated — disclosure without honest evaluation.
  const forgedResult: GateChainResult = {
    outcome: 'granted',
    disclosed,
    redacted: [],
    gatesEvaluated: [],
  }
  const forged = await signReceipt(
    buildReceipt(forgedResult, grantRef, { timestamp }),
    actor.secretKey,
  )

  const honestVerifies = await verifyReceipt(honest, actor.did)
  const forgedVerifies = await verifyReceipt(forged, actor.did)

  return makeCaseResult(
    '07-skip-eval-detected',
    'A receipt that discloses without evaluating gates fails verification',
    [
      { label: 'honest receipt (full gate chain) verifies', ok: honestVerifies === true },
      { label: 'skip-eval forgery is detected at the receipt layer', ok: detectSkipEvaluation(forged) === true },
      { label: 'skip-eval forgery FAILS verification despite a valid signature', ok: forgedVerifies === false },
      { label: 'honest receipt is not flagged as skip-eval', ok: detectSkipEvaluation(honest) === false },
    ],
  )
}
