import { makeCaseResult, tamperSignature, type ConformanceCase } from '../harness.js'
import {
  buildReceipt,
  signReceipt,
  computeReceiptId,
  payloadOf,
  verifySubjectAddressedReceipt,
  type Receipt,
} from '../../receipt.js'
import { InMemoryReceiptStore } from '../../receipt-store.js'
import { generateKeyPair } from '../../did-key.js'
import { exportSubject, verifyExport, importSubject, type SlfPortableExport } from '../../export.js'
import type { GateChainResult } from '../../gate-engine.js'

/**
 * Case 14 — SP-2: lossless SLF-format portable export.
 *
 * Spec: docs/specifications/SLF-SOVEREIGNTY-CONFORMANCE-PROFILE-v0.1-2026-06-20.md §SP-2.
 *
 * A conformant store MUST be able to export a subject's substrate elements as signed
 * SLF objects with their intrinsic gates and provenance intact, in a form another
 * conformant store can load without loss of signature, gate, or provenance fidelity.
 *
 * In slf-core the signed substrate element IS the receipt: it carries the gate
 * evaluations (outcome / gatesEvaluated / disclosed+redactedFields) and the
 * provenance (id / prevReceiptId / chainId / timestamp / grantRef), all committed
 * by the actor signature and the hash chain. SP-1 made a receipt subject-addressable
 * and third-party-verifiable; SP-2 exports the full set a store holds for a subject.
 *
 * This case exports subject S's facts from store A across a JSON wire (so store B is
 * genuinely independent — object identity is severed), verifies each object's
 * signature and gates, loads them into store B, and confirms the loaded objects
 * verify and carry byte-identical signatures, gates, and provenance. A tampered
 * object is detected on verify and rejected on load — never appended.
 */
const DISCLOSURE_GATES = ['substrate-gate', 'lens-projection', 'frame-check']

/** Build and sign one receipt, chaining off the previous one (issuer signs). */
async function buildSignedReceipt(
  issuerSecret: Uint8Array,
  subjectRef: string,
  grantId: string,
  result: GateChainResult,
  timestamp: number,
  prev?: Receipt,
): Promise<Receipt> {
  const unsigned = buildReceipt(result, { id: grantId }, {
    timestamp,
    subjectRef,
    prevReceiptId: prev?.id,
    chainId: prev?.chainId,
  })
  return signReceipt(unsigned, issuerSecret)
}

/** The provenance fields SP-2 requires to survive a round-trip unchanged. */
function sameProvenance(a: Receipt, b: Receipt): boolean {
  return (
    a.id === b.id &&
    (a.prevReceiptId ?? null) === (b.prevReceiptId ?? null) &&
    (a.chainId ?? null) === (b.chainId ?? null) &&
    a.timestamp === b.timestamp &&
    a.grantRef === b.grantRef
  )
}

export const sp2PortableExportCase: ConformanceCase = async () => {
  const issuer = generateKeyPair()
  const subject = generateKeyPair() // subject S — the data subject being exported
  const other = generateKeyPair() // a different subject whose receipts must NOT export

  const granted: GateChainResult = {
    outcome: 'granted',
    disclosed: [{ id: 'a1', balance: 100 }],
    redacted: [],
    gatesEvaluated: DISCLOSURE_GATES,
  }
  const partial: GateChainResult = {
    outcome: 'partial',
    disclosed: [{ id: 'a2', note: 'visible' }],
    redacted: [{ fact: { ssn: '000-00-0000' }, reasonCode: 'gate-redacted' }],
    gatesEvaluated: DISCLOSURE_GATES,
  }
  const denied: GateChainResult = {
    outcome: 'denied',
    disclosed: [],
    redacted: [],
    gatesEvaluated: [],
    reasonCode: 'scope-mismatch',
  }

  const t = 1_780_000_000_000

  // Store A holds three of subject S's signed substrate elements, hash-chained,
  // plus one element for a DIFFERENT subject that must be filtered out of the export.
  const storeA = new InMemoryReceiptStore()
  const r1 = await buildSignedReceipt(issuer.secretKey, subject.did, 'grant-1', granted, t)
  await storeA.append(r1)
  const r2 = await buildSignedReceipt(issuer.secretKey, subject.did, 'grant-2', partial, t + 1000, r1)
  await storeA.append(r2)
  const r3 = await buildSignedReceipt(issuer.secretKey, subject.did, 'grant-3', denied, t + 2000, r2)
  await storeA.append(r3)
  const rOther = await buildSignedReceipt(issuer.secretKey, other.did, 'grant-x', granted, t + 3000, r3)
  await storeA.append(rOther)

  const source = [r1, r2, r3]

  // ── Export S from store A ────────────────────────────────────────────────
  const exported = await exportSubject(storeA, subject.did, issuer.did)

  const filteredToSubject =
    exported.subjectRef === subject.did &&
    exported.objects.length === 3 &&
    exported.objects.every((o) => o.subjectRef === subject.did) &&
    !exported.objects.some((o) => o.receipt.id === rOther.id) &&
    JSON.stringify(exported.objects.map((o) => o.receipt.id)) ===
      JSON.stringify(source.map((r) => r.id))

  // Every exported object verifies from public material alone (signature + gates).
  const exportVerdict = await verifyExport(exported)
  const allObjectsVerify = exportVerdict.ok && exportVerdict.results.length === 3

  // Tampering any object's signature is caught by verifyExport.
  const tamperedExport: SlfPortableExport = {
    ...exported,
    objects: exported.objects.map((o, i) =>
      i === 1
        ? { ...o, receipt: { ...o.receipt, actorSignature: tamperSignature(o.receipt.actorSignature ?? '') } }
        : o,
    ),
  }
  const tamperDetectedOnVerify = (await verifyExport(tamperedExport)).ok === false

  // ── Cross the wire: store B deserializes an independent copy ──────────────
  const received = JSON.parse(JSON.stringify(exported)) as SlfPortableExport
  const storeB = new InMemoryReceiptStore()
  const importResult = await importSubject(storeB, received)
  const loaded = await storeB.all()
  const loadedCleanly =
    importResult.imported === 3 && importResult.rejected === 0 && loaded.length === 3

  // Each loaded object: signature re-verifies, gates identical, provenance identical.
  let signaturesIdentical = loaded.length === 3
  let gatesIdentical = loaded.length === 3
  let provenanceIntact = loaded.length === 3
  for (let i = 0; i < source.length; i++) {
    const src = source[i]
    const got = loaded[i]
    if (!got) {
      signaturesIdentical = gatesIdentical = provenanceIntact = false
      break
    }
    if (got.actorSignature !== src.actorSignature) signaturesIdentical = false

    const fromA = await verifySubjectAddressedReceipt({
      subjectRef: subject.did,
      issuerDid: issuer.did,
      receipt: src,
    })
    const fromB = await verifySubjectAddressedReceipt({
      subjectRef: subject.did,
      issuerDid: issuer.did,
      receipt: got,
    })
    if (
      !fromB.verified ||
      JSON.stringify(fromB.gateEvaluations) !== JSON.stringify(fromA.gateEvaluations)
    ) {
      gatesIdentical = false
    }

    // Provenance fields equal AND the hash-chain link recomputes to the stored id.
    if (!sameProvenance(src, got) || computeReceiptId(payloadOf(got), got.prevReceiptId) !== got.id) {
      provenanceIntact = false
    }
  }

  // An import carrying a tampered object rejects it and never appends it.
  const storeC = new InMemoryReceiptStore()
  const tamperedReceived = JSON.parse(JSON.stringify(tamperedExport)) as SlfPortableExport
  const tamperImport = await importSubject(storeC, tamperedReceived)
  const tamperedRejectedNotAppended =
    tamperImport.imported === 2 &&
    tamperImport.rejected === 1 &&
    tamperImport.rejections[0]?.index === 1 &&
    (await storeC.all()).length === 2

  return makeCaseResult(
    '14-sp2-portable-export',
    'SP-2: a subject export round-trips into an independent store with identical signatures, gates, and provenance',
    [
      { label: 'export carries only subject S’s elements (foreign subject filtered out)', ok: filteredToSubject },
      { label: 'every exported object verifies (signature + gates) from public material alone', ok: allObjectsVerify },
      { label: 'tampering an exported object’s signature is detected on verify', ok: tamperDetectedOnVerify },
      { label: 'the clean export loads into an independent store across a JSON wire', ok: loadedCleanly },
      { label: 'loaded objects carry byte-identical actor signatures', ok: signaturesIdentical },
      { label: 'loaded objects verify in store B and carry identical gates', ok: gatesIdentical },
      { label: 'loaded objects carry identical provenance and intact hash-chain links', ok: provenanceIntact },
      { label: 'a tampered object is rejected on load and never appended', ok: tamperedRejectedNotAppended },
    ],
  )
}
