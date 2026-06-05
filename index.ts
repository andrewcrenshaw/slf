// slf-core public API - the Substrate-Lens-Frame (SLF) reference implementation.
//
// The render(substrate, lens, frame) -> receipt round trip is assembled from the
// modules below: keys and signing, grants and their scope language, the four-step
// gate engine (substrate gate -> lens -> frame -> human approval), payload-free
// hash-chained receipts, relying-party acceptance, the enforcement-tier
// vocabulary, and crypto-erasure.

// Core data model: Grant, Lens, Frame, ScopeExpression, GateOutcome, KeyPair.
export * from './src/types.js'

// Keys and signing: did:key generation, Ed25519 over RFC-8785 canonical JSON.
export * from './src/did-key.js'
export * from './src/signing.js'

// Grants: create, sign, verify, plus a warm-path verification cache.
export * from './src/grant.js'
export * from './src/grant-cache.js'
export * from './src/scope-eval.js'

// The four-step gate engine and its individual gates.
export * from './src/gate-engine.js'
export * from './src/gates/substrate-gate.js'
export * from './src/gates/lens-projection.js'
export * from './src/gates/frame-check.js'
export * from './src/gates/hitl-gate.js'

// Receipts: payload-free, hash-chained, signed. The extended Receipt (carrying
// gatesEvaluated and enforcementTier) is re-exported explicitly so it takes
// precedence over the base Receipt shape from types.js.
export {
  buildReceipt,
  signReceipt,
  verifyReceipt,
  payloadOf,
  computeReceiptId,
  detectSkipEvaluation,
  type Receipt,
  type ReceiptPayload,
  type BuildReceiptOptions,
} from './src/receipt.js'
export * from './src/receipt-store.js'
export * from './src/receipt-chain.js'

// Relying-party acceptance (receipt-as-precondition) and the enforcement tiers.
export * from './src/consume.js'
export * from './src/tier.js'

// Crypto-erasure: seal under a per-subject key, shred the key, prove unrecoverability.
export * from './src/erasure.js'
