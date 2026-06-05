import { generateKeyPair } from '../src/did-key.js'
import {
  buildReceipt,
  signReceipt,
  verifyReceipt,
} from '../src/receipt.js'
import type { GateChainResult } from '../src/gate-engine.js'

const grantRef = { id: 'grant-123' }

function granted(disclosed: Array<Record<string, unknown>>): GateChainResult {
  return {
    outcome: 'granted',
    disclosed,
    redacted: [],
    gatesEvaluated: ['substrate-gate', 'lens-projection', 'frame-check', 'hitl-gate'],
  }
}

describe('receipt — emit + sign', () => {
  it('a granted read produces a verifiable signed receipt with disclosed fields and grant ref', async () => {
    const actor = generateKeyPair()
    const result = granted([{ entity_type: 'decision', text: 'ship it', author: 'alice' }])

    const receipt = await signReceipt(
      buildReceipt(result, grantRef, { timestamp: 1717000000000 }),
      actor.secretKey,
    )

    expect(receipt.outcome).toBe('granted')
    expect(receipt.grantRef).toBe('grant-123')
    // field names are the sorted union of disclosed fact keys
    expect(receipt.disclosedFields).toEqual(['author', 'entity_type', 'text'])
    expect(receipt.redactedFields).toEqual([])
    expect(receipt.gatesEvaluated).toContain('frame-check')
    expect(typeof receipt.id).toBe('string')
    expect(receipt.actorSignature).toBeTruthy()

    expect(await verifyReceipt(receipt, actor.did)).toBe(true)
  })

  it('verification fails for a one-byte-tampered signature', async () => {
    const actor = generateKeyPair()
    const receipt = await signReceipt(
      buildReceipt(granted([{ a: 1 }]), grantRef, { timestamp: 1 }),
      actor.secretKey,
    )
    const segs = receipt.actorSignature!.split('.')
    const sig = segs[2]
    // Flip the FIRST signature char (always significant); the last base64url char
    // is mostly padding and flipping it is a ~25% no-op (see grant.test.ts note).
    const flipped = (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1)
    const tampered = { ...receipt, actorSignature: [segs[0], segs[1], flipped].join('.') }

    expect(await verifyReceipt(tampered, actor.did)).toBe(false)
  })

  it('verification fails when the signature was made by a different key', async () => {
    const actor = generateKeyPair()
    const other = generateKeyPair()
    const receipt = await signReceipt(
      buildReceipt(granted([{ a: 1 }]), grantRef, { timestamp: 1 }),
      actor.secretKey,
    )
    expect(await verifyReceipt(receipt, other.did)).toBe(false)
  })

  it('a denied read records the reason code and redacted fields', async () => {
    const actor = generateKeyPair()
    const result: GateChainResult = {
      outcome: 'denied',
      disclosed: [],
      redacted: [
        { fact: { entity_type: 'claim', sensitivity: 'health-data' }, reasonCode: 'frame-not-authorized' },
      ],
      gatesEvaluated: ['substrate-gate', 'lens-projection', 'frame-check'],
      reasonCode: 'frame-not-authorized',
    }

    const receipt = await signReceipt(
      buildReceipt(result, { id: 'grant-9' }, { timestamp: 2 }),
      actor.secretKey,
    )

    expect(receipt.outcome).toBe('denied')
    expect(receipt.reasonCode).toBe('frame-not-authorized')
    expect(receipt.redactedFields).toEqual(['entity_type', 'sensitivity'])
    expect(receipt.disclosedFields).toEqual([])
    expect(await verifyReceipt(receipt, actor.did)).toBe(true)
  })

  it('mutating receipt content after signing breaks verification (signature binds to content)', async () => {
    const actor = generateKeyPair()
    const receipt = await signReceipt(
      buildReceipt(granted([{ a: 1 }]), grantRef, { timestamp: 1 }),
      actor.secretKey,
    )
    const mutated = { ...receipt, outcome: 'denied' as const }
    expect(await verifyReceipt(mutated, actor.did)).toBe(false)
  })
})
