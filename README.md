# slf-core

Reference implementation of **Substrate-Lens-Frame (SLF)**, a governance layer for agent memory. Apache-2.0.

Agent memory has become its own layer in the AI stack, and almost all of the work in it goes to one question: how well can the system recall the right fact at the right time. That work matters. But it leaves a second question open, and it is the one that decides whether agent memory can be trusted with regulated or personal data - who is allowed to see a fact, how its meaning changes by role and jurisdiction, and what was disclosed to whom. SLF puts the access rules inside the fact, so the rules travel with the fact and are re-checked on every read.

`slf-core` is the standalone library that implements the round trip end to end: did:key (a Decentralized Identifier method) key generation and Ed25519 signing, the four-step gate engine, hash-chained payload-free receipts, crypto-erasure, and an executable conformance suite. It carries no proprietary dependency, so you can clone it and run the suite.

> Status: alpha. The core round trip is built, tested, and benchmarked; several parts are designed but not yet built (see [What is demonstrated vs designed](#what-is-demonstrated-vs-designed)). The API may change before a 1.0.

## The primitive

One operation recurs at every layer of the protocol:

```
view = render(substrate, lens, frame) -> receipt
```

- **Substrate** - an immutable, signed fact that carries its own access rules ("gates"). The store is bi-temporal and append-only, so it can answer what was true at any past moment without losing history.
- **Lens** - a consumer-scoped projection (a role and a jurisdiction) that can only narrow what the gates already allow. Lens code never sees what a gate excludes, so it cannot leak it.
- **Frame** - the run-time outcome being pursued, and the unit of authorization. A grant authorizes specific frames, not open-ended access.
- **Receipt** - a signed, payload-free record of every operation: what was disclosed, the gates evaluated, and the frame scope. Receipts hash-chain, so the audit trail is verifiable without re-exposing the content.

Evaluation is monotonic: substrate gates, then lens, then frame, then human approval where the frame calls for one. Each step can only narrow what the previous step allowed.

## Install and run

```bash
npm install
npm test          # 126 tests across 19 suites
npm run bench     # gate-engine + crypto microbenchmarks
```

A standard `npm install` builds everything the suite needs, and all 126 tests pass. A few integration tests drive the gate engine against a real SQLite substrate through `better-sqlite3`, a native module compiled during install - if you install with `--ignore-scripts`, or on a platform with neither a prebuilt binary nor a build toolchain, the native driver is absent and those tests cannot load. A plain `npm install` resolves it.

## Quickstart

```ts
import {
  generateKeyPair, createGrant, signGrant,
  evaluateGateChainWithReceipt, InMemoryReceiptStore,
  verifyReceipt, acceptDisclosure, verifyChain,
} from 'slf-core'

const owner = generateKeyPair()
const now = Math.floor(Date.now() / 1000)

// A signed grant scoped to facts, valid for an hour, usable only in the read-summary frame.
const grant = await signGrant(createGrant({
  issuer: owner.did,
  subject: owner.did,
  scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
  allowedFrames: ['read-summary'],
  validity: { iat: now - 60, exp: now + 3600 },
}), owner.secretKey)

// The substrate the engine reads. In a deployment this is your own store.
const fetcher = { async fetchFacts() { return [
  { id: 'f1', entity_type: 'fact',  content: 'visible to this lens' },
  { id: 'c1', entity_type: 'claim', content: 'filtered out by the lens' },
] } }

const store = new InMemoryReceiptStore()
const { result, receipt } = await evaluateGateChainWithReceipt(
  grant,
  {
    requestId: 'req-1',
    lens:  { id: 'L', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] },
    frame: { id: 'read-summary', taskSlug: 'read-summary', intent: 'read', nextStep: 'review', requiresApproval: false, allowedFrames: ['read-summary'] },
  },
  fetcher,
  { store, actorSecretKey: owner.secretKey },
)

result.outcome                              // 'granted'
result.disclosed.length                     // 1 - the claim was filtered out by the lens
await verifyReceipt(receipt, owner.did)     // true
verifyChain(await store.all()).valid        // true

// The relying side refuses data that does not arrive with a valid receipt.
const accepted = await acceptDisclosure({ receipt, data: result.disclosed }, { actorDid: owner.did })
accepted.accepted                           // true
```

## Conformance suite

The conformance suite is the artifact behind the claim that SLF is enforced by code, not prose.

```bash
npx jest conformance
```

The command-line suite runs nine cases; the test gate adds three threat-model cases, the property suite, and the crypto-erasure case.

| Case | What it demonstrates |
|---|---|
| 01 valid-grant | A signed, in-window grant permits an in-scope read and emits a `granted` receipt |
| 02 expired-grant | An expired grant is denied before any read (`grant-expired`) |
| 03 gate-redaction | A gate-tagged fact the grant does not authorize is redacted, and the receipt records it |
| 04 frame-not-authorized | A frame outside `allowedFrames` is denied |
| 05 tampered-grant | A tampered grant fails verification before the reader is invoked |
| 06 hitl-approval | A `requiresApproval` frame pauses, then resumes on an approval token |
| 07 skip-eval-detected | A receipt that discloses without naming the governing gates is rejected as a forgery |
| 08 suppressed-receipt-rejected | The relying side refuses disclosed data that arrives with no valid receipt |
| 09 tier-claim-mismatch | A weaker-tier receipt cannot claim a stronger tier's guarantee |
| 10 canary-exfiltration | Across a 32-variant adversarial corpus, a prompt-broadened agent reaches zero canary leakage; every exclusion is receipted |
| 11 cross-tenant-isolation | A cross-tenant adversary reaches zero cross-tenant disclosures |
| 12 crypto-erasure | Sealed content round-trips, and is unrecoverable once the per-subject key is shredded |
| real-corpus | The gate chain enforces a grant against a read-only snapshot of a real agent-memory corpus. It skips cleanly when none is present, which is the right behavior for a public clone. |

The property suite (`monotonic-narrowing.property.test.ts`) checks, over more than a thousand generated cases, that narrowing a grant never widens what is disclosed.

## What is demonstrated vs designed

Keeping these apart is the point.

**Demonstrated** (in the conformance suite, and confirmed by an independent from-scratch exercise):

- the grant to scoped-read to receipt round trip, with a gate-excluded fact never reaching the reader;
- a signed receipt on every terminal operation, and a tampered or suppressed receipt rejected;
- monotonic narrowing, over more than a thousand generated cases;
- zero leakage across a 32-variant adversarial corpus, every exclusion receipted;
- crypto-erasure: sealed content is unrecoverable once the per-subject key is shredded.

**Measured** (single Apple M4 core; see [BENCHMARK.md](BENCHMARK.md)): once a grant is verified, gate evaluation on the read path runs at about a nine-microsecond 95th-percentile latency, roughly 0.1% of a typical vector retrieval at 5 to 20 milliseconds. The cost lives on the write path: every operation signs a receipt (an Ed25519 signature is about 146 microseconds), a receipt write-amplification of roughly 90x the warm read throughput. Batched or asynchronous receipt emission reduces that ratio. The synchronous figure is reported here rather than hidden behind the read-path number.

**Designed, not built:** the gate-authoring pipeline (how a fact acquires its gates at ingest, with a coverage figure on a real corpus), multi-vault federation, attested-execution (Trusted Execution Environment) enforcement behind a counterparty, and a mechanized proof of monotonic narrowing along the path AWS Cedar took.

## Honest qualifiers

These keep the claims on register, and they are not optional:

- This is **conformance-tested**, not "proven secure," "formally verified," or "audited." The leak result is evidence under attack across 32 variants, not a proof of non-interference.
- A protocol cannot be "compliant." `slf-core` is **compliance-enabling**: it produces the gates, enforcement points, and receipts a deployer's data-protection impact assessment can cite as mitigating measures. Only a deployed system can be assessed for compliance.
- The numbers are single-machine, single-core measurements, not a load test at scale.
- The cryptography rests on the standard `@noble` libraries used in a standard way. It has not had a formal cryptographic audit.

## Layout

```
src/
  did-key.ts, signing.ts        keys + Ed25519/JWS over RFC-8785 canonical JSON
  grant.ts, grant-cache.ts      grants: create, sign, verify, warm-path cache
  scope-eval.ts                 six-operator scope language (AND/OR/NOT/EQUALS/WITHIN/MATCHES)
  gate-engine.ts                the four-step chain + receipt emission
  gates/                        substrate-gate, lens-projection, frame-check, hitl-gate
  receipt.ts, receipt-chain.ts  payload-free hash-chained receipts
  receipt-store.ts              append-only receipt log (in-memory reference store)
  consume.ts                    relying-party acceptance (receipt-as-precondition)
  tier.ts                       enforcement-tier vocabulary (T0..T3)
  erasure.ts                    crypto-shredding
  conformance/                  executable cases, harness, leak corpus, property generator
bench/                          gate-engine + crypto microbenchmarks
```

## More

- [ARCHITECTURE.md](ARCHITECTURE.md) - the four-step pipeline, the data model, and the design rationale.
- [THREAT_MODEL.md](THREAT_MODEL.md) - the adversaries SLF is built against, and the control for each.
- [spec/SPA-ARCHITECTURE.md](spec/SPA-ARCHITECTURE.md) - the broader Sovereign Personal Agent architecture SLF is designed for (a design document).
- [SECURITY.md](SECURITY.md) - how to report a vulnerability.
- [BENCHMARK.md](BENCHMARK.md) - performance methodology and numbers.

## Reference and citation

`slf-core` is the reference implementation for the position paper *The Governance Gap in Agentic Memory: Substrate-Lens-Frame, a sovereign, auditable memory protocol for AI agents* (Andrew Crenshaw, 2026). See [CITATION.cff](CITATION.cff). The canonical paper and a citable DOI are added here on deposit. The project hub - paper, specifications, and background - lives at https://lexenne.com/slf.

## Stewardship

A protocol that gives individuals and institutions ownership of their data should not be the property of a single vendor. The specification, the conformance suite, and the vocabulary registries are meant to sit with a neutral steward rather than any single implementer - open and permissively licensed today, with a dedicated nonprofit reserved for if scale or funding warrants one. Any commercial implementation is held to the same conformance discipline as anyone else. The reference implementation is Apache-2.0, and nothing in the protocol requires it: the standard is adoptable without its author.

This draft is for pressure-testing. If you can break the leak property, the narrowing property, or the erasure guarantee, that is the contribution this most needs - open an issue.

## License

Apache-2.0. See [LICENSE](LICENSE).
