import { verifyReceipt, type Receipt } from './receipt.js'
import { DEFAULT_ENFORCEMENT_TIER, receiptSupportsTierClaim, type EnforcementTier } from './tier.js'

/**
 * A disclosure as it arrives at the relying (consuming) side: the disclosed
 * payload plus the receipt the discloser is supposed to attach. A `null` or
 * `undefined` receipt models a discloser that SUPPRESSED it (§4 threat model).
 */
export interface Disclosure<T = unknown> {
  receipt: Receipt | null | undefined
  data: T
}

export type DisclosureRejectionReason = 'no-receipt' | 'invalid-receipt' | 'insufficient-tier'

export interface AcceptDisclosureParams {
  /** DID of the actor expected to have signed the receipt. */
  actorDid: string
  /** Optional minimum enforcement tier the relying side requires (§3 + §6). */
  requiredTier?: EnforcementTier
}

export type AcceptDisclosureResult<T = unknown> =
  | { accepted: true; data: T; receipt: Receipt }
  | { accepted: false; reasonCode: DisclosureRejectionReason }

/**
 * Receipt-as-precondition (PROPOSAL-SLF §4.1, Fork 3). The relying side refuses
 * to accept or act on disclosed data that does not arrive with a valid,
 * actor-signed receipt — so a discloser who SUPPRESSES the receipt produces data
 * nobody will use, and suppression costs them the transaction. This flips the
 * incentive from "please log this" to "no receipt, no completed transaction."
 *
 * Normativity: the spec target is a MUST for Case-B audiences, but in slf-core
 * v0 this is SHOULD-level deployment guidance — the mechanism is present and
 * tested; whether a given audience enforces it is a deployment choice. The
 * function IS the receipt-as-precondition enforcement point.
 */
export async function acceptDisclosure<T>(
  disclosure: Disclosure<T>,
  params: AcceptDisclosureParams,
): Promise<AcceptDisclosureResult<T>> {
  const { receipt } = disclosure

  // Suppression: a discloser that attached no receipt produces unusable data.
  if (!receipt) {
    return { accepted: false, reasonCode: 'no-receipt' }
  }

  // A receipt that does not verify (no/forged signature, mutated content,
  // skip-evaluation forgery) is no better than a suppressed one.
  if (!(await verifyReceipt(receipt, params.actorDid))) {
    return { accepted: false, reasonCode: 'invalid-receipt' }
  }

  // Optional: refuse a receipt whose enforcement tier is weaker than required.
  if (params.requiredTier) {
    const produced = receipt.enforcementTier ?? DEFAULT_ENFORCEMENT_TIER
    if (!receiptSupportsTierClaim(produced, params.requiredTier)) {
      return { accepted: false, reasonCode: 'insufficient-tier' }
    }
  }

  return { accepted: true, data: disclosure.data, receipt }
}
