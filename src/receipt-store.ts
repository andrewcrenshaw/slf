import type { Receipt } from './receipt.js'

/**
 * Append-only receipt log. Receipts hash-chain (see receipt-chain.ts), so the
 * store deliberately exposes no update or delete surface — history is immutable.
 */
export interface ReceiptStore {
  append(receipt: Receipt): Promise<void>
  all(): Promise<Receipt[]>
  /** Most recently appended receipt, for chaining the next one (undefined when empty). */
  head(): Promise<Receipt | undefined>
}

/** In-memory reference implementation of {@link ReceiptStore}. */
export class InMemoryReceiptStore implements ReceiptStore {
  private readonly receipts: Receipt[] = []

  async append(receipt: Receipt): Promise<void> {
    this.receipts.push(receipt)
  }

  async all(): Promise<Receipt[]> {
    return [...this.receipts]
  }

  async head(): Promise<Receipt | undefined> {
    return this.receipts[this.receipts.length - 1]
  }
}
