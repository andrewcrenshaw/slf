import {
  emitSubjectAddressedReceipt,
  verifySubjectAddressedReceipt,
  UNSPECIFIED_SUBJECT,
  type SubjectAddressedReceipt,
  type SubjectVerification,
} from './receipt.js'
import type { ReceiptStore } from './receipt-store.js'

/**
 * SP-2 — lossless SLF-format portable export.
 *
 * Spec: docs/specifications/SLF-SOVEREIGNTY-CONFORMANCE-PROFILE-v0.1-2026-06-20.md §SP-2.
 *
 * A conformant store MUST be able to export a subject's substrate elements as
 * signed SLF objects with their intrinsic gates and provenance intact, in a form
 * another conformant store can load without loss of signature, gate, or provenance
 * fidelity.
 *
 * In slf-core the signed substrate element IS the receipt: the actor signature and
 * the hash chain commit its gate evaluations (outcome, gatesEvaluated, disclosed /
 * redacted fields) and its provenance (id, prevReceiptId, chainId, timestamp,
 * grantRef). SP-1 (receipt.ts) made a single receipt subject-addressable and
 * third-party-verifiable; this module exports the full set a store holds for one
 * subject as a plain-JSON, serializable bundle of those subject-addressed objects.
 * Because each object is carried verbatim, a round trip loses nothing: the loaded
 * objects verify under the issuer's public did and carry identical gates and
 * provenance — see {@link importSubject} and conformance case 14.
 */

/** Discriminator + version stamped on every export so a loader can recognise the format. */
export const SLF_EXPORT_FORMAT = 'slf-portable-export'
export const SLF_EXPORT_VERSION = '0.1'

/** A portable, lossless export of one subject's signed substrate elements (SP-2). */
export interface SlfPortableExport {
  format: typeof SLF_EXPORT_FORMAT
  version: typeof SLF_EXPORT_VERSION
  /** The data subject whose elements this export carries. */
  subjectRef: string
  /** Each element: a subject-addressed, independently-verifiable signed receipt. */
  objects: SubjectAddressedReceipt[]
}

/**
 * Export every signed substrate element a store holds for `subjectRef` as portable,
 * independently-verifiable SLF objects. Each element is wrapped via SP-1's
 * {@link emitSubjectAddressedReceipt}, carrying only the issuer's PUBLIC did, so the
 * export moves no secret. The result is plain JSON — `JSON.stringify` it onto any
 * wire and another conformant store loads it with {@link importSubject}.
 *
 * `issuerDid` is the public did of the principal that signed these receipts; a
 * holder needs only this to verify every object. Receipts for other subjects are
 * filtered out — an export is scoped to a single data subject.
 */
export async function exportSubject(
  store: ReceiptStore,
  subjectRef: string,
  issuerDid: string,
): Promise<SlfPortableExport> {
  const all = await store.all()
  const objects = all
    .filter((receipt) => (receipt.subjectRef ?? UNSPECIFIED_SUBJECT) === subjectRef)
    .map((receipt) => emitSubjectAddressedReceipt(receipt, issuerDid))
  return { format: SLF_EXPORT_FORMAT, version: SLF_EXPORT_VERSION, subjectRef, objects }
}

/** The outcome of verifying every object in an export. */
export interface ExportVerification {
  /** true iff the export is non-empty and every object verified. */
  ok: boolean
  /** Per-object verdicts, in export order. */
  results: SubjectVerification[]
}

/**
 * Verify every object in an export — signature, subject-binding, and gate-evaluation
 * integrity — using only the public did each object carries. `ok` is true iff the
 * export holds at least one object and all of them verify; a tampered signature, a
 * re-addressed envelope, or a skip-evaluation forgery in any object makes `ok` false.
 */
export async function verifyExport(exported: SlfPortableExport): Promise<ExportVerification> {
  const results: SubjectVerification[] = []
  for (const object of exported.objects) {
    results.push(await verifySubjectAddressedReceipt(object))
  }
  return { ok: results.length > 0 && results.every((r) => r.verified), results }
}

/** One object an import declined to load, with the verification reason. */
export interface ImportRejection {
  /** Index of the rejected object within the export's `objects`. */
  index: number
  /** The verification failure reason (e.g. 'receipt-signature-invalid'). */
  reason: string
}

/** The outcome of loading an export into a destination store. */
export interface ImportResult {
  imported: number
  rejected: number
  rejections: ImportRejection[]
}

/**
 * Load a portable export into a destination store. Each object is verified BEFORE it
 * is appended; an object that fails verification is rejected and never written, so a
 * tampered or forged element cannot enter the destination chain. Objects that verify
 * are appended verbatim, preserving their signature, gates, and provenance exactly.
 */
export async function importSubject(
  store: ReceiptStore,
  exported: SlfPortableExport,
): Promise<ImportResult> {
  const rejections: ImportRejection[] = []
  let imported = 0
  for (let index = 0; index < exported.objects.length; index++) {
    const object = exported.objects[index]
    const verdict = await verifySubjectAddressedReceipt(object)
    if (!verdict.verified) {
      rejections.push({ index, reason: verdict.reason ?? 'verification-failed' })
      continue
    }
    await store.append(object.receipt)
    imported++
  }
  return { imported, rejected: rejections.length, rejections }
}
