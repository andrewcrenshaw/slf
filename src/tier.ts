/**
 * Enforcement-tier labels (PROPOSAL-SLF-ENFORCEMENT-LOCUS §3).
 *
 * Every gate guarantee is graded by the tier the *enforcer* actually achieves.
 * The label is DESCRIPTIVE of the principal that ran the gate engine — it is not
 * a self-asserted upgrade a holder can write in to look stronger. A receipt
 * produced under a weaker tier cannot substantiate a stronger tier's guarantee
 * (§6: "a T3 receipt cannot claim a T0/T2 guarantee").
 *
 * | Tier | Enforcer / trust root                               | Guarantee              |
 * |------|-----------------------------------------------------|------------------------|
 * | T0   | The user's own vault / SPA (Case A, sovereign self) | Prevention (structural)|
 * | T1   | Provider inside an attestable runtime (TEE)         | Prevention, conditional|
 * | T2   | Whoever holds the decryption capability             | Prevention (crypto)    |
 * | T3   | Provider holding plaintext we cannot constrain      | Accountability only    |
 */
export type EnforcementTier = 'T0' | 'T1' | 'T2' | 'T3'

/** The kind of guarantee a tier delivers: structural/crypto prevention vs ex-post accountability. */
export type GuaranteeClass = 'prevention' | 'accountability'

export const ENFORCEMENT_TIERS = ['T0', 'T1', 'T2', 'T3'] as const

/**
 * slf-core v0 is the sovereign-self (Case A) reference impl — the user's own
 * software both holds the facts and runs the gates — so every receipt it
 * produces is T0 unless an explicit weaker tier is stamped.
 */
export const DEFAULT_ENFORCEMENT_TIER: EnforcementTier = 'T0'

/**
 * Guarantee strength, higher = stronger. T0 (sovereign self-enforcement) needs
 * no external trust root and carries the strong "lens never sees excluded facts"
 * claim; T1/T2 are conditional prevention (attestation / key custody); T3 is
 * accountability-only. The ordering encodes the spec's load-bearing rule:
 * prevention (T0/T1/T2) strictly outranks accountability (T3), so an
 * accountability receipt can never pass for a prevention guarantee.
 */
const TIER_STRENGTH: Record<EnforcementTier, number> = { T0: 3, T1: 2, T2: 1, T3: 0 }

/** Type guard: is `value` one of the four known tier labels? */
export function isEnforcementTier(value: unknown): value is EnforcementTier {
  return typeof value === 'string' && (ENFORCEMENT_TIERS as readonly string[]).includes(value)
}

/** prevention for T0/T1/T2; accountability for T3 (§3). */
export function tierGuarantee(tier: EnforcementTier): GuaranteeClass {
  return tier === 'T3' ? 'accountability' : 'prevention'
}

/** Numeric guarantee strength (higher = stronger). */
export function tierStrength(tier: EnforcementTier): number {
  return TIER_STRENGTH[tier]
}

/**
 * Does a receipt PRODUCED under `produced` substantiate a CLAIM of `claimed`?
 * True only when the produced tier is at least as strong as the claimed one. A
 * T3 receipt claiming T0 (or T2) returns false — the anti-overclaim rule. A
 * stronger receipt may always substantiate a weaker claim (downgrade is honest).
 */
export function receiptSupportsTierClaim(
  produced: EnforcementTier,
  claimed: EnforcementTier,
): boolean {
  return TIER_STRENGTH[produced] >= TIER_STRENGTH[claimed]
}
