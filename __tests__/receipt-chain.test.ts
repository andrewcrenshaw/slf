import { generateKeyPair } from '../src/did-key.js'
import {
  buildReceipt,
  signReceipt,
  computeReceiptId,
  payloadOf,
  type Receipt,
} from '../src/receipt.js'
import { verifyChain } from '../src/receipt-chain.js'
import { InMemoryReceiptStore } from '../src/receipt-store.js'
import type { GateChainResult } from '../src/gate-engine.js'

const grantRef = { id: 'grant-x' }

async function makeReceipt(
  secretKey: Uint8Array,
  outcome: 'granted' | 'denied',
  ts: number,
  prevReceiptId?: string,
  chainId?: string,
): Promise<Receipt> {
  const result: GateChainResult = {
    outcome,
    disclosed: outcome === 'granted' ? [{ k: ts }] : [],
    redacted: outcome === 'denied' ? [{ fact: { k: ts }, reasonCode: 'frame-not-authorized' }] : [],
    gatesEvaluated: ['substrate-gate'],
    reasonCode: outcome === 'denied' ? 'frame-not-authorized' : undefined,
  }
  return signReceipt(buildReceipt(result, grantRef, { timestamp: ts, prevReceiptId, chainId }), secretKey)
}

describe('receipt-chain — hash-chain integrity', () => {
  it('a clean chain of receipts verifies', async () => {
    const actor = generateKeyPair()
    const r1 = await makeReceipt(actor.secretKey, 'granted', 1)
    const r2 = await makeReceipt(actor.secretKey, 'denied', 2, r1.id, r1.chainId)
    const r3 = await makeReceipt(actor.secretKey, 'granted', 3, r2.id, r2.chainId)

    const v = verifyChain([r1, r2, r3])
    expect(v.valid).toBe(true)
    expect(v.brokenAt).toBeUndefined()
    // every receipt id is the SHA256 hash-chain link
    expect(r2.id).toBe(computeReceiptId(payloadOf(r2), r1.id))
    expect(r2.prevReceiptId).toBe(r1.id)
  })

  it('tampering an earlier receipt content breaks verification at that index', async () => {
    const actor = generateKeyPair()
    const r1 = await makeReceipt(actor.secretKey, 'granted', 1)
    const r2 = await makeReceipt(actor.secretKey, 'denied', 2, r1.id, r1.chainId)
    const r3 = await makeReceipt(actor.secretKey, 'granted', 3, r2.id, r2.chainId)

    // mutate r2's content WITHOUT recomputing its id
    const tampered = { ...r2, outcome: 'granted' as const }
    const v = verifyChain([r1, tampered, r3])
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(1)
  })

  it('re-hashing a tampered receipt still breaks the link to its successor', async () => {
    const actor = generateKeyPair()
    const r1 = await makeReceipt(actor.secretKey, 'granted', 1)
    const r2 = await makeReceipt(actor.secretKey, 'denied', 2, r1.id, r1.chainId)
    const r3 = await makeReceipt(actor.secretKey, 'granted', 3, r2.id, r2.chainId)

    // attacker mutates r2 AND recomputes its id so r2 self-verifies...
    const mutated = { ...r2, outcome: 'granted' as const }
    const rehashedId = computeReceiptId(payloadOf(mutated), mutated.prevReceiptId)
    const rehashed = { ...mutated, id: rehashedId }

    // ...but r3.prevReceiptId still points at the ORIGINAL r2.id -> link broken at index 2
    const v = verifyChain([r1, rehashed, r3])
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(2)
  })

  it('the in-memory store is append-only and chains receipts head-to-tail', async () => {
    const store = new InMemoryReceiptStore()
    const actor = generateKeyPair()

    const r1 = await makeReceipt(actor.secretKey, 'granted', 1)
    await store.append(r1)
    expect((await store.head())!.id).toBe(r1.id)

    const head = (await store.head())!
    const r2 = await makeReceipt(actor.secretKey, 'denied', 2, head.id, head.chainId)
    await store.append(r2)

    const all = await store.all()
    expect(all).toHaveLength(2)
    expect(all[1].prevReceiptId).toBe(all[0].id)
    expect(all[1].chainId).toBe(all[0].id)
    expect(verifyChain(all).valid).toBe(true)
    // append-only: no mutation/delete surface
    expect((store as unknown as Record<string, unknown>).update).toBeUndefined()
    expect((store as unknown as Record<string, unknown>).delete).toBeUndefined()
  })
})
