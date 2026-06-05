import { acceptDisclosure } from '../src/consume.js'
import { generateKeyPair } from '../src/did-key.js'
import { buildReceipt, signReceipt, type Receipt } from '../src/receipt.js'
import type { EnforcementTier } from '../src/tier.js'
import type { GateChainResult } from '../src/gate-engine.js'

const grantRef = { id: 'grant-consume' }

function grantedResult(): GateChainResult {
  return {
    outcome: 'granted',
    disclosed: [{ entity_type: 'fact', text: 'payload' }],
    redacted: [],
    gatesEvaluated: ['substrate-gate', 'lens-projection', 'frame-check', 'hitl-gate'],
  }
}

async function validReceipt(secretKey: Uint8Array, tier?: EnforcementTier): Promise<Receipt> {
  return signReceipt(buildReceipt(grantedResult(), grantRef, { timestamp: 1, tier }), secretKey)
}

describe('acceptDisclosure — receipt-as-precondition', () => {
  it('accepts disclosed data that arrives with a valid receipt', async () => {
    const actor = generateKeyPair()
    const receipt = await validReceipt(actor.secretKey)
    const res = await acceptDisclosure({ receipt, data: { text: 'payload' } }, { actorDid: actor.did })
    expect(res.accepted).toBe(true)
    if (res.accepted) expect(res.data).toEqual({ text: 'payload' })
  })

  it('refuses data when the receipt is suppressed (null or undefined)', async () => {
    const actor = generateKeyPair()
    const resNull = await acceptDisclosure({ receipt: null, data: {} }, { actorDid: actor.did })
    const resUndef = await acceptDisclosure({ receipt: undefined, data: {} }, { actorDid: actor.did })
    expect(resNull.accepted).toBe(false)
    if (!resNull.accepted) expect(resNull.reasonCode).toBe('no-receipt')
    expect(resUndef.accepted).toBe(false)
    if (!resUndef.accepted) expect(resUndef.reasonCode).toBe('no-receipt')
  })

  it('refuses data when the receipt is present but unsigned', async () => {
    const actor = generateKeyPair()
    const unsigned = buildReceipt(grantedResult(), grantRef, { timestamp: 1 })
    const res = await acceptDisclosure({ receipt: unsigned, data: {} }, { actorDid: actor.did })
    expect(res.accepted).toBe(false)
    if (!res.accepted) expect(res.reasonCode).toBe('invalid-receipt')
  })

  it('refuses data when the receipt was signed by a different key', async () => {
    const actor = generateKeyPair()
    const other = generateKeyPair()
    const receipt = await validReceipt(actor.secretKey)
    const res = await acceptDisclosure({ receipt, data: {} }, { actorDid: other.did })
    expect(res.accepted).toBe(false)
    if (!res.accepted) expect(res.reasonCode).toBe('invalid-receipt')
  })

  it('refuses when the receipt tier is weaker than the required tier', async () => {
    const actor = generateKeyPair()
    const t3 = await validReceipt(actor.secretKey, 'T3')
    const res = await acceptDisclosure({ receipt: t3, data: {} }, { actorDid: actor.did, requiredTier: 'T0' })
    expect(res.accepted).toBe(false)
    if (!res.accepted) expect(res.reasonCode).toBe('insufficient-tier')
  })

  it('accepts when the receipt tier meets the required tier', async () => {
    const actor = generateKeyPair()
    const t0 = await validReceipt(actor.secretKey, 'T0')
    const res = await acceptDisclosure({ receipt: t0, data: { ok: true } }, { actorDid: actor.did, requiredTier: 'T0' })
    expect(res.accepted).toBe(true)
  })
})
