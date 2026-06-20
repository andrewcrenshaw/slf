# Threat model

"Auditable" and "cannot leak" mean little without a named adversary. This document lists the adversaries `slf-core` is built against, the control that addresses each, and - importantly - the residue each control leaves. It mirrors section 5 of the position paper and points at the conformance cases that exercise the claims.

The vocabulary is standard: STRIDE for the security threats, LINDDUN for the privacy ones, and the OWASP Top 10 for LLM Applications for the agent-specific risks.

## The adversaries

**1. Honest-but-curious lens.** A lens that runs the protocol correctly but tries to infer what a gate excludes. *Control:* the lens reads only what survives the substrate gate, so an excluded fact never enters lens code and cannot be disclosed from it. *(LINDDUN linking and inference; STRIDE information disclosure. Exercised by conformance case 03 and the gate ordering in `gate-engine.ts`.)*

**2. Malicious holder.** A counterparty that skips or fakes evaluation behind its own walls. This is the difficult case. *Control:* receipts make the dishonesty detectable - a receipt that discloses fields without naming the disclosure-governing gates is rejected as a skip-evaluation forgery, and a suppressed receipt makes the disclosed data unusable on the relying side. Provable honest evaluation needs an attested execution environment (see Enforcement locus below). *(STRIDE tampering and repudiation. Cases 07 and 08.)*

**3. Prompt-injected agent.** An agent whose instructions have been broadened by injection, trying to exfiltrate a gated fact through its own lens. *Control:* the gate excludes the fact before the lens runs, so a broadened prompt has nothing to widen. *(OWASP LLM01, prompt injection. Case 10, the canary-exfiltration corpus.)*

**4. Cross-tenant adversary.** A reader trying to reach another tenant's facts, including by inverting shared embeddings back to source text. *Control:* gates are evaluated per read against the requesting grant; a foreign tenant's grant does not satisfy them. *(OWASP LLM08, vector and embedding weaknesses. Case 11, cross-tenant isolation.)*

**5. Network adversary.** An observer who replays messages or shows different log histories to different parties (a split-view attack). *Control:* the receipt log is hash-chained and content-addressed, so a split view or a reordered history fails `verifyChain`. Independent witnesses over the log close the remaining gap. *(STRIDE spoofing and tampering. `receipt-chain.ts`.)*

**6. Forged HITL approver.** An actor that fabricates a human approval to resume a read a frame paused for oversight. *Control:* an approval token is a signed, request-bound, expiring artifact - an Ed25519 signature from the approver's did:key over the canonical `{requestId, approver, iat, exp}` claims. The gate resumes only when the signature verifies, the token's `requestId` matches the paused request, and the token has not expired; a bare `approve:` prefix, an unsigned token, a token minted for another request, an expired token, or a signature that does not match the claimed approver DID all pause for a real human rather than disclosing. *Residue:* a valid signature proves only that the holder of some key approved, not that the key belongs to an authorized approver. Given a trusted-approver set the gate rejects approvals from any other DID; without one, a self-asserted approver DID with its own keypair still produces a structurally valid token. Binding a DID to approval authority is a deployer act (see Out of scope below). *(STRIDE spoofing and elevation of privilege; OWASP LLM06, excessive agency. Case 06, HITL approval.)*

## The tension worth naming

SLF wants non-repudiation of operations, which is itself a privacy threat to the subject under LINDDUN: a perfect audit trail is also a perfect record of behavior. Payload-free receipts are the mitigation. A receipt records field names, the gates evaluated, and the frame scope, never the disclosed values, so the trail proves what happened without re-exposing what was disclosed.

## The leak result, and what it is not

The strongest claim is that a lens cannot leak what a gate excludes. That is an information-flow property, and a property like that is only credible once a red team has tried to break it. Across a 32-variant adversarial corpus (`src/conformance/leak-corpus.json`), a prompt-broadened agent reaches a zero leak rate against a gate-excluded canary, the cross-tenant adversary reaches zero cross-tenant disclosures, and every exclusion is receipted.

That is evidence under attack, not a proof of non-interference. A 32-variant corpus is strong evidence, not exhaustive coverage, and a failed attack is not a theorem. A larger published corpus and a mechanized proof along Cedar's path are named as next steps, not as done.

## Enforcement locus: where the gate actually runs

The guarantee a gate delivers depends on who runs the engine. The enforcement tiers (`tier.ts`) grade this honestly:

- **T0, sovereign self.** The substrate is under the data owner's own control and runs the owner's engine, so the gate cannot be skipped. This is `slf-core`'s default and the strong "a lens never sees an excluded fact" guarantee holds structurally.
- **T1 / T2, conditional prevention.** A provider inside an attested runtime, or whoever holds the decryption capability.
- **T3, accountability only.** A provider that holds plaintext we cannot constrain. Here the gate cannot be guaranteed to run; the receipt gives after-the-fact accountability, not prevention.

Behind a counterparty, the protocol today gives tamper-evident detection with bounded latency. An attested execution environment (the IETF remote-attestation model, RFC 9334) lets a counterparty prove it ran the unmodified gate engine, at a measured overhead of a few percent for compute-bound work. `slf-core` is at the detection tier today and names attestation as the path that closes the gap. The anti-overclaim rule (`receiptSupportsTierClaim`) ensures a weaker-tier receipt cannot pass for a stronger guarantee.

## Out of scope for the protocol

These are real limits, stated here rather than discovered later. They are the deployer's responsibility, not something the library can enforce:

- **Key hygiene.** Crypto-erasure holds only if no copy of a subject key survives in a backup, escrow, or recovery service.
- **Public replication.** A widely replicated public substrate cannot reconcile a right to erasure, so personal-data deployments should be permissioned, not public.
- **Cross-border transfer legality.** SLF can encode which jurisdiction's rules govern a read and can evidence every cross-border disclosure, but the lawful basis for a transfer is a deployer act.
- **Standing-grant judgment.** A standing grant makes the human-oversight boundary enforceable and visible; it cannot decide which decisions cross the threshold that requires fresh human approval for a given deployment.
- **Approver authority binding.** The HITL gate authenticates that an approval token was signed by the approver DID it names, bound to the paused request, and unexpired. Which DIDs are *authorized* to approve is a deployer binding: supplied to the gate as a trusted-approver set, or enforced by controlling which keys are ever issued. Without that set the gate proves the signer holds the key, not that the signer has standing to approve.
- **Cryptographic assurance.** The primitives are the standard `@noble` libraries used in a standard way. They have not had a formal cryptographic audit.

## Reporting

Found a way to break the leak property, the narrowing property, the chain integrity, or the erasure guarantee? That is exactly what this draft is for. See [SECURITY.md](SECURITY.md).
