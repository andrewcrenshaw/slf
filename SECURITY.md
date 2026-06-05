# Security policy

`slf-core` is alpha-stage research code published for pressure-testing. This policy says what to expect and how to report a problem.

## Posture

Stated plainly so there is no misreading:

- The library is **conformance-tested**, not audited. There has been no formal cryptographic or security audit.
- The cryptography is the standard `@noble` libraries (`@noble/ed25519`, `@noble/hashes`, `@noble/ciphers`) and `jose`, used in a standard way. The security of the primitives rests on those libraries.
- The leak-resistance result is evidence under attack across a 32-variant corpus, not a proof. See [THREAT_MODEL.md](THREAT_MODEL.md).
- The protocol is **compliance-enabling**, not "compliant." Only a deployed system can be assessed for compliance.

## Reporting a vulnerability

Email **andrew@lexenne.com** with enough detail to reproduce: the property you broke, the steps, and the impact. A proof-of-concept against the conformance suite or a minimal script is ideal.

Please report privately first and give a reasonable window to respond before any public disclosure. There is no bug-bounty program; this is a research project, and credit is given to reporters who want it.

## What is most worth attacking

The claims that carry weight, and that a report would most usefully challenge:

- **Leak resistance** - a lens disclosing a fact the substrate gate excluded.
- **Monotonic narrowing** - a narrower grant widening what is disclosed.
- **Receipt integrity** - a tampered or skip-evaluation receipt passing `verifyReceipt`, or a mutated chain passing `verifyChain`.
- **Crypto-erasure** - recovering sealed content after the subject key is shredded.

## Scope

In scope: the `slf-core` library code in this repository. Out of scope: the deployer responsibilities listed in [THREAT_MODEL.md](THREAT_MODEL.md) (key hygiene, public replication, transfer legality), and third-party dependencies, which should be reported upstream.
