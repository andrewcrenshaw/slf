import { computeReceiptId, payloadOf, type Receipt } from './receipt.js'

export interface ChainVerification {
  valid: boolean
  /** Index of the first receipt where the chain breaks (absent when valid). */
  brokenAt?: number
  reason?: string
}

/**
 * Verify an ordered receipt chain.
 *
 * Two independent defenses, checked per receipt:
 *  1. content integrity — recompute SHA256(prev_id || canonical(payload)) and
 *     require it to equal the stored id. Mutating any receipt's content (without
 *     re-hashing) fails here at that index.
 *  2. link integrity — require receipt[i].prevReceiptId === receipt[i-1].id.
 *     Re-hashing a tampered receipt to pass (1) changes its id, which then
 *     breaks the successor's back-link here.
 */
export function verifyChain(receipts: Receipt[]): ChainVerification {
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i]

    const expectedId = computeReceiptId(payloadOf(receipt), receipt.prevReceiptId)
    if (expectedId !== receipt.id) {
      return { valid: false, brokenAt: i, reason: 'receipt-content-altered' }
    }

    if (i > 0 && receipt.prevReceiptId !== receipts[i - 1].id) {
      return { valid: false, brokenAt: i, reason: 'chain-link-broken' }
    }
  }
  return { valid: true }
}
