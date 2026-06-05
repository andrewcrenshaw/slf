import {
  DEFAULT_ENFORCEMENT_TIER,
  ENFORCEMENT_TIERS,
  isEnforcementTier,
  receiptSupportsTierClaim,
  tierGuarantee,
  tierStrength,
} from '../src/tier.js'
import { generateKeyPair } from '../src/did-key.js'
import { buildReceipt, signReceipt, verifyReceipt } from '../src/receipt.js'
import type { GateChainResult } from '../src/gate-engine.js'

describe('enforcement tiers', () => {
  it('exposes the four tier labels in strength order T0..T3', () => {
    expect(ENFORCEMENT_TIERS).toEqual(['T0', 'T1', 'T2', 'T3'])
    expect(DEFAULT_ENFORCEMENT_TIER).toBe('T0')
  })

  it('maps each tier to a guarantee class (prevention for T0-T2, accountability for T3)', () => {
    expect(tierGuarantee('T0')).toBe('prevention')
    expect(tierGuarantee('T1')).toBe('prevention')
    expect(tierGuarantee('T2')).toBe('prevention')
    expect(tierGuarantee('T3')).toBe('accountability')
  })

  it('guards unknown tier labels', () => {
    expect(isEnforcementTier('T0')).toBe(true)
    expect(isEnforcementTier('T3')).toBe(true)
    expect(isEnforcementTier('T9')).toBe(false)
    expect(isEnforcementTier(0)).toBe(false)
    expect(isEnforcementTier(undefined)).toBe(false)
  })

  it('substantiates a claim only at or below the produced strength', () => {
    expect(receiptSupportsTierClaim('T0', 'T0')).toBe(true)
    expect(receiptSupportsTierClaim('T0', 'T3')).toBe(true) // downgrade is honest
    expect(receiptSupportsTierClaim('T3', 'T0')).toBe(false) // anti-overclaim
    expect(receiptSupportsTierClaim('T3', 'T2')).toBe(false)
    expect(receiptSupportsTierClaim('T3', 'T3')).toBe(true)
  })

  it('ranks every prevention tier strictly above the accountability tier', () => {
    for (const t of ['T0', 'T1', 'T2'] as const) {
      expect(tierStrength(t)).toBeGreaterThan(tierStrength('T3'))
      expect(receiptSupportsTierClaim(t, 'T3')).toBe(true)
      expect(receiptSupportsTierClaim('T3', t)).toBe(false)
    }
  })
})

describe('tier label on receipts', () => {
  const grantRef = { id: 'grant-tier-test' }
  const result: GateChainResult = {
    outcome: 'granted',
    disclosed: [{ a: 1 }],
    redacted: [],
    gatesEvaluated: ['substrate-gate', 'lens-projection', 'frame-check', 'hitl-gate'],
  }

  it('defaults to T0 (sovereign self-enforcement) when no tier is given', () => {
    const r = buildReceipt(result, grantRef, { timestamp: 1 })
    expect(r.enforcementTier).toBe('T0')
  })

  it('stamps the requested tier and binds it into the signature', async () => {
    const actor = generateKeyPair()
    const r = await signReceipt(buildReceipt(result, grantRef, { timestamp: 1, tier: 'T3' }), actor.secretKey)
    expect(r.enforcementTier).toBe('T3')
    expect(await verifyReceipt(r, actor.did)).toBe(true)
  })

  it('relabeling the tier after signing breaks verification (descriptive, not self-asserted)', async () => {
    const actor = generateKeyPair()
    const r = await signReceipt(buildReceipt(result, grantRef, { timestamp: 1, tier: 'T3' }), actor.secretKey)
    const upgraded = { ...r, enforcementTier: 'T0' as const }
    expect(await verifyReceipt(upgraded, actor.did)).toBe(false)
  })
})
