import {
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  type ConformanceCase,
} from '../harness.js'
import { generateKeyPair } from '../../did-key.js'
import {
  createGrant,
  signGrant,
  signAuthoredGate,
  signGateRevocation,
  signConsumerRequest,
} from '../../grant.js'
import type { GateChainResult, ReadRequest } from '../../gate-engine.js'
import type { Frame, Lens, ScopeExpression } from '../../types.js'

/**
 * Case 15 — SP-3: individual-controlled identity anchoring.
 *
 * Spec: docs/specifications/SLF-SOVEREIGNTY-CONFORMANCE-PROFILE-v0.1-2026-06-20.md §SP-3.
 * Design: docs/architecture/SLF-SP3-DESIGN-individual-identity-anchoring-2026-06-20.md.
 *
 * Grants and frames are resolvable against subject-controlled identifiers
 * (did:key here — an individual-held DID), not solely against issuer-issued
 * identity. The keystone is the authored gate: a subject-held key authors a
 * signed, restrict-only gate on a fact about them, and that gate binds an
 * enterprise-issued read grant regardless of who stores the fact. The individual
 * is a cryptographic authority over the gates on their own substrate element.
 *
 * This case proves, all from public material:
 *  - a subject-authored restrict gate DENIES an enterprise grant that would
 *    otherwise disclose the fact (and — the load-bearing, non-vacuous check —
 *    dropping the gate flips the same read to disclosed);
 *  - the subject can REVOKE their own gate and re-permit the read, while a forged
 *    or third-party revocation cannot;
 *  - a grant issued TO an individual-held DID, and a grant issued BY one, evaluate
 *    identically to issuer-issued identity;
 *  - the consumer is cryptographically bound to the grant audience (mismatch,
 *    bad-key, and replay tokens are rejected);
 *  - a MATCHES authored predicate is refused (ReDoS, design §6).
 */
export const sp3IndividualIdentityAnchoringCase: ConformanceCase = async () => {
  const enterprise = generateKeyPair() // issuer in the enterprise-held deployment
  const subject = generateKeyPair() // the individual — authority over gates on facts about them
  const consumer = generateKeyPair() // an enterprise-side reader (grant audience)
  const individual = generateKeyPair() // an individual-held reader DID — identity is not hard-coded
  const attacker = generateKeyPair()

  const now = Math.floor(Date.now() / 1000)
  const window = { iat: now - 60, exp: now + 3600 }
  const frameId = 'read-summary'
  const scope: ScopeExpression = { op: 'EQUALS', field: 'entity_type', value: 'fact' }
  const gatePredicate: ScopeExpression = { op: 'EQUALS', field: 'purpose', value: 'subject-consented' }

  const lens: Lens = { id: 'lens-15', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-summary',
    intent: 'read facts',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameId],
  }

  const baseFact = { id: 'f1', entity_type: 'fact', content: 'a fact about the subject', domain: 'general' }

  // The subject authors a signed restrict gate on the fact, then a tombstone for it.
  const subjectGate = await signAuthoredGate(
    { id: 'gate-1', author: subject.did, predicate: gatePredicate, validity: window },
    subject.secretKey,
  )
  const gatedFact = { ...baseFact, gates: [subjectGate] }

  // Build + sign a Read grant with an explicit audience and (optional) subject seat.
  async function grantTo(params: {
    issuer: { did: string; secretKey: Uint8Array }
    audience: string
    subject?: string
    scopeExpression?: ScopeExpression
  }): Promise<ReturnType<typeof createGrant>> {
    const g = createGrant({
      issuer: params.issuer.did,
      audience: params.audience,
      subject: params.subject,
      scopeExpression: params.scopeExpression ?? scope,
      allowedFrames: [frameId],
      validity: window,
    })
    return signGrant(g, params.issuer.secretKey)
  }

  // Run one guarded read with a consumer-bound request.
  async function read(
    grant: Awaited<ReturnType<typeof grantTo>>,
    facts: Array<Record<string, unknown>>,
    req: { requestId: string; holderDid?: string; consumerRequest?: string },
  ): Promise<GateChainResult> {
    const { ctx } = newCaseContext()
    const request: ReadRequest = {
      requestId: req.requestId,
      lens,
      frame,
      holderDid: req.holderDid,
      consumerRequest: req.consumerRequest,
    }
    const { result } = await runGuardedRead(grant, request, spyFetcher(facts), ctx)
    return result
  }

  const enterpriseGrant = await grantTo({ issuer: enterprise, audience: consumer.did, subject: subject.did })

  // ── A1: subject restrict gate denies an enterprise grant that would disclose ──
  const reqA = 'case-15-a'
  const restricted = await read(enterpriseGrant, [gatedFact], {
    requestId: reqA,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqA, holderDid: consumer.did }, consumer.secretKey),
  })
  const deniedBySubjectGate =
    restricted.disclosed.length === 0 &&
    restricted.redacted.some((r) => r.reasonCode === 'subject-gate-restricted')

  // ── A2: NON-VACUOUS mutant — drop the subject gate, the same read discloses ──
  const reqB = 'case-15-b'
  const mutant = await read(enterpriseGrant, [baseFact], {
    requestId: reqB,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqB, holderDid: consumer.did }, consumer.secretKey),
  })
  const mutantDiscloses = mutant.disclosed.length === 1 && mutant.disclosed[0].id === 'f1'
  const gateIsLoadBearing = deniedBySubjectGate && mutantDiscloses

  // ── A3: the subject revokes their own gate and the read re-permits ──
  const revocation = await signGateRevocation({ gateId: 'gate-1', author: subject.did, iat: now }, subject.secretKey)
  const reqC = 'case-15-c'
  const afterRevoke = await read(enterpriseGrant, [{ ...gatedFact, gateRevocations: [revocation] }], {
    requestId: reqC,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqC, holderDid: consumer.did }, consumer.secretKey),
  })
  const revocationRePermits = afterRevoke.disclosed.length === 1 && afterRevoke.disclosed[0].id === 'f1'

  // ── A4: a forged revocation (subject named, attacker-signed) cannot lift it ──
  const forgedRev = await signGateRevocation({ gateId: 'gate-1', author: subject.did, iat: now }, attacker.secretKey)
  const reqD = 'case-15-d'
  const forged = await read(enterpriseGrant, [{ ...gatedFact, gateRevocations: [forgedRev] }], {
    requestId: reqD,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqD, holderDid: consumer.did }, consumer.secretKey),
  })
  const forgedRevocationRejected =
    forged.disclosed.length === 0 && forged.redacted.some((r) => r.reasonCode === 'subject-gate-restricted')

  // ── A5: a third party's own valid revocation cannot retire the subject's gate ──
  const thirdPartyRev = await signGateRevocation({ gateId: 'gate-1', author: attacker.did, iat: now }, attacker.secretKey)
  const reqE = 'case-15-e'
  const thirdParty = await read(enterpriseGrant, [{ ...gatedFact, gateRevocations: [thirdPartyRev] }], {
    requestId: reqE,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqE, holderDid: consumer.did }, consumer.secretKey),
  })
  const onlyAuthorCanRevoke =
    thirdParty.disclosed.length === 0 && thirdParty.redacted.some((r) => r.reasonCode === 'subject-gate-restricted')

  // ── A6: an unsigned authored gate is ignored (never honored on weak evidence) ──
  const unsignedGate = { id: 'gate-2', author: subject.did, predicate: gatePredicate, validity: window }
  const reqF = 'case-15-f'
  const unsigned = await read(enterpriseGrant, [{ ...baseFact, gates: [unsignedGate] }], {
    requestId: reqF,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqF, holderDid: consumer.did }, consumer.secretKey),
  })
  const unsignedGateIgnored = unsigned.disclosed.length === 1 && unsigned.disclosed[0].id === 'f1'

  // ── A7: a grant issued TO an individual-held DID evaluates identically ──
  const grantToIndividual = await grantTo({ issuer: enterprise, audience: individual.did, subject: subject.did })
  const reqG = 'case-15-g'
  const toIndividual = await read(grantToIndividual, [baseFact], {
    requestId: reqG,
    holderDid: individual.did,
    consumerRequest: await signConsumerRequest({ requestId: reqG, holderDid: individual.did }, individual.secretKey),
  })
  const individualAudienceIdentical =
    toIndividual.outcome === mutant.outcome &&
    JSON.stringify(toIndividual.disclosed) === JSON.stringify(mutant.disclosed)

  // ── A8: a grant issued BY an individual-held DID verifies and reads identically ──
  const grantByIndividual = await grantTo({ issuer: subject, audience: consumer.did })
  const reqH = 'case-15-h'
  const byIndividual = await read(grantByIndividual, [baseFact], {
    requestId: reqH,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqH, holderDid: consumer.did }, consumer.secretKey),
  })
  const individualIssuerIdentical =
    byIndividual.outcome === mutant.outcome &&
    JSON.stringify(byIndividual.disclosed) === JSON.stringify(mutant.disclosed)

  // ── A9: consumer mismatch (holder != grant audience) is rejected ──
  const reqI = 'case-15-i'
  const mismatch = await read(enterpriseGrant, [baseFact], {
    requestId: reqI,
    holderDid: attacker.did,
    consumerRequest: await signConsumerRequest({ requestId: reqI, holderDid: attacker.did }, attacker.secretKey),
  })
  const consumerMismatchRejected =
    mismatch.outcome === 'denied' && mismatch.reasonCode === 'consumer-mismatch' && mismatch.disclosed.length === 0

  // ── A10: a request token signed by the wrong key is rejected ──
  const reqJ = 'case-15-j'
  const badToken = await read(enterpriseGrant, [baseFact], {
    requestId: reqJ,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqJ, holderDid: consumer.did }, attacker.secretKey),
  })
  const badTokenRejected = badToken.outcome === 'denied' && badToken.reasonCode === 'consumer-request-invalid'

  // ── A11: a replayed token (bound to another requestId) is rejected ──
  const replayToken = await signConsumerRequest({ requestId: 'some-other-request', holderDid: consumer.did }, consumer.secretKey)
  const reqK = 'case-15-k'
  const replay = await read(enterpriseGrant, [baseFact], {
    requestId: reqK,
    holderDid: consumer.did,
    consumerRequest: replayToken,
  })
  const replayRejected = replay.outcome === 'denied' && replay.reasonCode === 'consumer-request-invalid'

  // ── A12: a grant whose scope satisfies the gate predicate discloses (intersection escape) ──
  const consentedFact = { ...baseFact, purpose: 'subject-consented', gates: [subjectGate] }
  const satisfyingGrant = await grantTo({
    issuer: enterprise,
    audience: consumer.did,
    subject: subject.did,
    scopeExpression: { op: 'AND', args: [scope, gatePredicate] },
  })
  const reqL = 'case-15-l'
  const satisfied = await read(satisfyingGrant, [consentedFact], {
    requestId: reqL,
    holderDid: consumer.did,
    consumerRequest: await signConsumerRequest({ requestId: reqL, holderDid: consumer.did }, consumer.secretKey),
  })
  const satisfyingGrantDiscloses = satisfied.disclosed.length === 1 && satisfied.disclosed[0].id === 'f1'

  // ── A13: a MATCHES authored predicate is refused at authoring (ReDoS, §6) ──
  let matchesRejected = false
  try {
    await signAuthoredGate(
      { id: 'gate-x', author: subject.did, predicate: { op: 'MATCHES', field: 'content', pattern: '.*' }, validity: window },
      subject.secretKey,
    )
  } catch {
    matchesRejected = true
  }

  return makeCaseResult(
    '15-sp3-individual-identity-anchoring',
    'SP-3: a subject-controlled key anchors individual-held identity for grants and frames and authors/revokes its own gate',
    [
      { label: 'a subject-authored restrict gate denies an enterprise grant that would otherwise disclose', ok: deniedBySubjectGate },
      { label: 'dropping the subject gate flips the same read to disclosed (gate is load-bearing, non-vacuous)', ok: gateIsLoadBearing },
      { label: 'the subject revokes their own gate and the read re-permits', ok: revocationRePermits },
      { label: 'a forged (attacker-signed) revocation cannot lift the subject gate', ok: forgedRevocationRejected },
      { label: 'only the gate author can revoke — a third party’s own revocation does not apply', ok: onlyAuthorCanRevoke },
      { label: 'an unsigned authored gate is ignored, never honored on weak evidence', ok: unsignedGateIgnored },
      { label: 'a grant issued to an individual-held DID evaluates identically to issuer-issued identity', ok: individualAudienceIdentical },
      { label: 'a grant issued by an individual-held DID verifies and reads identically', ok: individualIssuerIdentical },
      { label: 'a consumer whose holder DID != grant audience is rejected', ok: consumerMismatchRejected },
      { label: 'a request token signed by the wrong key is rejected', ok: badTokenRejected },
      { label: 'a replayed token bound to another request is rejected', ok: replayRejected },
      { label: 'a grant whose scope satisfies the subject predicate discloses (monotonic intersection)', ok: satisfyingGrantDiscloses },
      { label: 'a MATCHES authored predicate is refused at authoring (ReDoS guard)', ok: matchesRejected },
    ],
  )
}
