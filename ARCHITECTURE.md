# Architecture

This document describes how `slf-core` works: the data model, the four-step gate engine, the receipt chain, the enforcement-tier vocabulary, and crypto-erasure. It is the implementation companion to the position paper *The Governance Gap in Agentic Memory* (Crenshaw, 2026). Where the paper argues the case, this document maps it to the code.

The design goal is a single primitive that recurs at every layer:

```
view = render(substrate, lens, frame) -> receipt
```

A view onto data is always a substrate, projected through a lens, bound to a frame, and accompanied by a signed receipt. The four components are defined once and inherited everywhere.

## 1. The data model

Five record types carry the protocol. All identifiers are strings; all signatures are compact JWS over RFC-8785 (JSON Canonicalization Scheme) canonical JSON, so the bytes that get hashed and signed are deterministic.

**Substrate fact** - a plain record the caller supplies through a `SubstrateFetcher`. The fields the gate engine reads are: `entity_type` (what the lens filters on), `valid_at` / `invalid_at` (bi-temporal bounds, Unix seconds), and `gates` (a string or array of regulatory tags such as `health-data`). Everything else is opaque payload the engine never inspects.

**Grant** (`types.ts`) - a signed, time-bounded capability:

```ts
interface Grant {
  id: string
  issuer: string          // did:key of the signer
  subject: string         // did:key of the data owner
  grantType: 'read'
  scopeExpression: ScopeExpression
  allowedFrames: string[]
  validity: { iat: number; exp: number }
  signature?: string      // compact JWS over the unsigned grant
}
```

**Lens** - a consumer-scoped projection: `{ id, role, jurisdiction, entityTypes }`. It binds a role and a jurisdiction at the moment of use and filters what is visible.

**Frame** - the run-time outcome and the unit of authorization: `{ id, taskSlug, intent, nextStep, requiresApproval, allowedFrames }`. A grant authorizes specific frames, not open-ended access.

**Receipt** (`receipt.ts`) - the payload-free audit record (see section 4).

## 2. The scope language

A grant's `scopeExpression` is a six-operator tree (`scope-eval.ts`):

| Operator | Meaning |
|---|---|
| `EQUALS {field, value}` | strict equality, `fact[field] === value` |
| `WITHIN {field, set}` | membership, `set.includes(fact[field])` |
| `MATCHES {field, pattern}` | regular-expression test on a string field |
| `AND {args:[a,b]}` / `OR {args:[a,b]}` / `NOT {arg}` | the boolean connectives |

The language is deliberately not Turing-complete: there are no loops and no recursion over data, only a finite walk of the expression tree. So the question "does this scope permit this read" is decidable in bounded time. This follows the analyzable-policy design AWS Cedar published and verified with mechanized proofs, rather than inventing a new policy language. One honest note: `MATCHES` delegates to the host regular-expression engine, so a pathological pattern is the grant author's own cost, not an external attack surface (the issuer writes the scope).

## 3. The four-step gate engine

`evaluateGateChain(grant, request, fetcher, opts)` (`gate-engine.ts`) runs four gates in a fixed order. Each step can only narrow what the previous step allowed - the monotonic-narrowing property the conformance suite checks over a thousand generated cases. The grant signature and validity window are verified before the substrate reader is ever touched, so nothing is read until the grant proves itself.

**Gate 1 - substrate gate** (`gates/substrate-gate.ts`), per fact:

1. `valid_at` in the future -> `fact-not-yet-valid`.
2. `invalid_at` at or before now -> `fact-expired`.
3. the grant's scope expression does not match the fact -> `scope-mismatch`.
4. the fact carries a restrictive gate tag (`health-data`, `personal-data`, `audience-restricted`) and the grant's scope does not explicitly reference the `gates` field -> `gate-tag-restricted`.

Rule 4 is the default-deny core: a fact tagged as sensitive is withheld unless the grant explicitly opted in by naming `gates` in its scope. A grant cannot pick up sensitive data by accident.

**Gate 2 - lens projection** (`gates/lens-projection.ts`). A fact is disclosed only if the lens admits its `entity_type` (an empty `entityTypes` admits all). Excluded facts are recorded as `entity-type-excluded`. The lens sees only what survives the substrate gate, so it cannot read - and therefore cannot leak - what the gate already removed.

**Gate 3 - frame check** (`gates/frame-check.ts`). The request's frame id must appear in the grant's `allowedFrames`, else the whole read is denied `frame-not-authorized`.

**Gate 4 - human-in-the-loop** (`gates/hitl-gate.ts`). If the frame does not require approval, it passes. If it does and no approval token is present, the read pauses at `pending_approval` with a count-only preview (no content). An `approve:` token resumes; a `deny:` token denies `approval-denied`. A pause is not a terminal outcome and emits no receipt; it resumes when the token arrives.

The terminal outcomes are `granted`, `denied`, `partial`, and `error`. `pending_approval` is a pause.

## 4. Receipts: payload-free and hash-chained

`evaluateGateChainWithReceipt(...)` wraps the chain and emits exactly one signed receipt for every terminal outcome (an engine exception is caught and recorded as an `error` receipt, so no terminal outcome is ever receiptless).

A receipt records field *names*, never values:

```ts
interface ReceiptPayload {
  grantRef: string
  outcome: GateOutcome
  reasonCode: string | null
  disclosedFields: string[]   // sorted union of disclosed fact keys
  redactedFields: string[]    // sorted union of redacted fact keys
  gatesEvaluated: string[]
  enforcementTier: EnforcementTier
  timestamp: number
}
```

Two integrity mechanisms travel with it:

- **Hash-chain link.** `id = SHA256(prevReceiptId || canonical(payload))`, hex. Receipts are content-addressed, and each points at its predecessor, so the log is append-only and tamper-evident.
- **Signature binding.** The actor signs `{ id, prevReceiptId, ...payload }`. `verifyReceipt` re-decodes the signed payload and compares it, through the same canonical encoder, to the receipt's current content. Any mutation after signing, a foreign key, or a missing signature fails verification.

`verifyReceipt` also rejects a **skip-evaluation forgery**: a signature-valid receipt that names disclosed fields but omits a disclosure-governing gate (`substrate-gate` or `lens-projection`) from `gatesEvaluated`. Disclosure without honest evaluation is treated as invalid even when the signature checks out.

`verifyChain(receipts)` (`receipt-chain.ts`) walks an ordered log and checks two things per receipt: content integrity (recompute the id) and link integrity (`prevReceiptId` equals the predecessor's id). Re-hashing a tampered receipt to pass the first check changes its id, which breaks the successor's back-link at the second.

## 5. Relying-party acceptance

`acceptDisclosure(disclosure, params)` (`consume.ts`) is the receipt-as-precondition enforcement point. The relying side refuses to act on disclosed data unless it arrives with a valid receipt:

- no receipt -> `no-receipt` (a discloser who suppresses the receipt produces unusable data);
- a receipt that fails `verifyReceipt` -> `invalid-receipt`;
- a receipt whose enforcement tier is weaker than a caller-required minimum -> `insufficient-tier`.

This flips the incentive from "please log this" to "no receipt, no completed transaction." In `slf-core` v0 it is deployment guidance the mechanism supports, not a protocol-level MUST for every audience.

## 6. Enforcement tiers

Every receipt is stamped with the tier the *enforcer* actually achieved (`tier.ts`):

| Tier | Enforcer / trust root | Guarantee |
|---|---|---|
| T0 | the user's own vault or agent (sovereign self) | prevention, structural |
| T1 | a provider inside an attestable runtime (TEE) | prevention, conditional |
| T2 | whoever holds the decryption capability | prevention, cryptographic |
| T3 | a provider holding plaintext we cannot constrain | accountability only |

The label is descriptive of the principal that ran the engine, not a self-asserted upgrade. The tier is part of the signed payload, so a holder cannot relabel a T3 receipt as T0 after the fact without invalidating the signature. `receiptSupportsTierClaim(produced, claimed)` enforces the anti-overclaim rule: a receipt substantiates a claim only when the tier it was produced under is at least as strong. `slf-core` is the sovereign-self (T0) reference implementation, so its receipts default to T0.

## 7. Crypto-erasure

The substrate is append-only, which raises the obvious question of how it honors a right to erasure. The answer is crypto-shredding (`erasure.ts`), the pattern the European Data Protection Board endorsed for blockchain-style stores and NIST classifies as a purge-level method.

- `sealContent(plaintext, key)` encrypts under XChaCha20-Poly1305 with a per-subject key and a fresh 24-byte nonce.
- `hmacCommit(content, key)` produces the keyed (HMAC-SHA256) hash that goes on the chain - a keyed hash, never a bare hash of the content, so it is not linkable once the key is gone.
- `shred(key)` zeroes the key in place. After it, `openContent` cannot recover the plaintext and the commitment is no longer linkable.
- `buildErasureReceipt(...)` records the erasure itself as a signed receipt, the accountability artifact, in transaction time while the fact disappears from valid-time reads.

Two limits are real and belong here rather than in a footnote: crypto-shredding holds only if no copy of the key survives in a backup or escrow, which is the deployer's key hygiene and not something the library can guarantee; and a widely replicated public substrate cannot reconcile erasure at all, so personal-data deployments should be permissioned.

## 8. Performance shape

Gate evaluation on a warm read path (grant signature already verified, via `grant-cache.ts`) is a few microseconds; the dominant cost is the Ed25519 receipt signature on the write path. The numbers, measured on a single Apple M4 core, are in [BENCHMARK.md](BENCHMARK.md). The headline is that governance adds about 0.1% to a typical vector retrieval on the read path, and the real cost is a roughly 90x receipt write-amplification that batched or asynchronous emission reduces.

## 9. What is demonstrated vs designed

The conformance suite, the property suite, the leak corpus, and the erasure case exercise the round trip end to end (see the [README](README.md) and [THREAT_MODEL.md](THREAT_MODEL.md)). Built and verified: the gate chain, receipts, monotonic narrowing, leak resistance across a 32-variant corpus, and crypto-erasure. Designed but not built: the gate-authoring pipeline (how a fact acquires its gates at ingest, with a coverage figure on a real corpus), multi-vault federation, attested-execution enforcement behind a counterparty, and a mechanized proof of monotonic narrowing. The verbs in this document track that line.

## 10. Why composition, not a new stack

SLF is mostly a composition over established work, and it is stronger for saying so. The decidable scope language follows AWS Cedar. The signed, scoped, time-bounded, revocable, attenuable grant is the macaroons / Biscuit / UCAN lineage, and the did:key signing places it in the UCAN family. A signed fact that carries its own metadata is a Verifiable Credential. The receipt chain is a transparency log in the Certificate Transparency tradition. The attested-execution path is the IETF remote-attestation (RATS) model. What is new is narrow: the fixed four-step monotonic pipeline, a governance-typed action taxonomy that gives a grant data-lifecycle meaning, and gates embedded in the fact and re-evaluated on every hop.
