import {
  makeCaseResult,
  newCaseContext,
  verifyReceipt,
  type ConformanceCase,
} from '../harness.js'
import {
  generateSubjectKey,
  sealContent,
  openContent,
  shred,
  buildErasureReceipt,
} from '../../erasure.js'

/**
 * Case 12 — Crypto-shred: per-subject AEAD seal + erasure receipt.
 * Demonstrates the EDPB-endorsed GDPR Art 17 crypto-shred pattern: content sealed
 * under a per-subject key is unrecoverable after key destruction, and the erasure
 * event is recorded as a verifiable payload-free receipt. Backs §4 of the position paper.
 */
export const cryptoErasureCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const grantRef = 'erased:subject-alice:case-12'

  const subjectKey = generateSubjectKey()
  const plaintext = new TextEncoder().encode('alice sensitive fact')
  const sealed = sealContent(plaintext, subjectKey)

  const opened = openContent(sealed, subjectKey)
  const roundTrips = Buffer.from(opened).equals(Buffer.from(plaintext))

  shred(subjectKey)

  let unrecoverable = false
  try {
    openContent(sealed, subjectKey)
  } catch {
    unrecoverable = true
  }

  const previous = await ctx.store.head()
  const erasureReceipt = await buildErasureReceipt(grantRef, actor.secretKey, {
    timestamp: ctx.now?.() ?? 1_780_000_000_000,
    prevReceiptId: previous?.id,
    chainId: previous?.chainId,
  })
  await ctx.store.append(erasureReceipt)

  const verified = await verifyReceipt(erasureReceipt, actor.did)

  return makeCaseResult(
    '12-crypto-erasure',
    'Crypto-shred: content sealed, unrecoverable after shred, erasure receipt verifies',
    [
      { label: 'sealContent + openContent round-trips before shred', ok: roundTrips },
      { label: 'content is unrecoverable after shred (zeroed key)', ok: unrecoverable },
      {
        label: 'erasure receipt has reasonCode erased and empty disclosedFields (payload-free)',
        ok:
          erasureReceipt.reasonCode === 'erased' &&
          (erasureReceipt.disclosedFields?.length ?? 0) === 0,
      },
      { label: 'erasure receipt signature verifies against actor DID', ok: verified },
    ],
  )
}
