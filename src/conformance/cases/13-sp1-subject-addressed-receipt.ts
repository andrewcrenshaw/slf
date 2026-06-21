import { makeCaseResult, tamperSignature, type ConformanceCase } from '../harness.js'
import {
  buildReceipt,
  emitSubjectAddressedReceipt,
  signReceipt,
  verifySubjectAddressedReceipt,
} from '../../receipt.js'
import { generateKeyPair } from '../../did-key.js'
import type { GateChainResult } from '../../gate-engine.js'

/**
 * Case 13 — SP-1: subject-addressable, third-party-verifiable receipts.
 *
 * Spec: docs/specifications/SLF-SOVEREIGNTY-CONFORMANCE-PROFILE-v0.1-2026-06-20.md §SP-1.
 *
 * The issuer signs a receipt that names its data subject. The engine emits a
 * subject-addressed copy carrying only the issuer's PUBLIC did. A holder that
 * holds a key the issuer does NOT hold (the subject's own keypair) and never
 * touches the issuer's secret verifies the copy — signature, subject-binding,
 * and gate evaluations — from public material alone. Presenting the wrong issuer
 * did, re-addressing the copy to a different subject, or tampering the signature
 * each break verification.
 */
export const sp1SubjectAddressedReceiptCase: ConformanceCase = async () => {
  const issuer = generateKeyPair()
  // The subject holds their own key — one the issuer does not possess.
  const subject = generateKeyPair()

  const gatesEvaluated = ['substrate-gate', 'lens-projection', 'frame-check']
  const result: GateChainResult = {
    outcome: 'partial',
    disclosed: [{ id: 'f1', balance: 1200 }],
    redacted: [{ fact: { ssn: '000-00-0000' }, reasonCode: 'gate-redacted' }],
    gatesEvaluated,
  }

  const timestamp = 1_780_000_000_000
  const unsigned = buildReceipt(result, { id: 'grant-sp1' }, { timestamp, subjectRef: subject.did })
  const receipt = await signReceipt(unsigned, issuer.secretKey)

  // The engine emits a copy addressed to the subject, carrying only the public did.
  const copy = emitSubjectAddressedReceipt(receipt, issuer.did)

  // Subject-as-holder verifies using only public material — no issuer secret.
  const holderVerdict = await verifySubjectAddressedReceipt(copy)

  // The emitted copy carries the issuer PUBLIC did and never the issuer secret.
  const issuerSecretB64 = Buffer.from(issuer.secretKey).toString('base64url')
  const carriesNoSecret =
    copy.issuerDid === issuer.did && !JSON.stringify(copy).includes(issuerSecretB64)

  // The gate evaluations the holder recovered are exactly the ones the issuer signed.
  const ev = holderVerdict.gateEvaluations
  const gatesMatch =
    ev?.outcome === 'partial' &&
    JSON.stringify(ev?.gatesEvaluated) === JSON.stringify(gatesEvaluated) &&
    JSON.stringify(ev?.disclosedFields) === JSON.stringify(['balance', 'id']) &&
    JSON.stringify(ev?.redactedFields) === JSON.stringify(['ssn'])

  // Wrong issuer did (the subject's own) fails — it is genuinely the issuer's signature.
  const wrongIssuer = await verifySubjectAddressedReceipt({ ...copy, issuerDid: subject.did })

  // Re-addressing the envelope to a different subject breaks subject-binding.
  const reAddressed = await verifySubjectAddressedReceipt({ ...copy, subjectRef: 'did:key:zAttacker' })

  // Tampering the signature (e.g. to forge altered gate evaluations) fails.
  const tampered = await verifySubjectAddressedReceipt({
    ...copy,
    receipt: { ...receipt, actorSignature: tamperSignature(receipt.actorSignature ?? '') },
  })

  return makeCaseResult(
    '13-sp1-subject-addressed-receipt',
    'SP-1: a subject-addressed receipt copy is independently verifiable by a non-issuer holder',
    [
      { label: 'receipt carries a subject reference', ok: receipt.subjectRef === subject.did },
      { label: 'emitted copy is addressed to the subject', ok: copy.subjectRef === subject.did },
      { label: 'copy carries the issuer public did and no issuer secret', ok: carriesNoSecret },
      {
        label:
          'holder verifies the copy under a key the issuer does not hold (subject keypair), using only the public did',
        ok: holderVerdict.verified === true,
      },
      { label: 'holder recovers the signed gate evaluations', ok: gatesMatch === true },
      { label: 'wrong issuer did fails verification', ok: wrongIssuer.verified === false },
      {
        label: 're-addressing the copy to another subject breaks subject-binding',
        ok: reAddressed.verified === false && reAddressed.reason === 'subject-binding-mismatch',
      },
      {
        label: 'tampered signature fails verification',
        ok: tampered.verified === false && tampered.reason === 'receipt-signature-invalid',
      },
    ],
  )
}
