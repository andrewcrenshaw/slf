import {
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  type ConformanceContext,
  type ConformanceCase,
} from '../harness.js'
import { generateKeyPair } from '../../did-key.js'
import { createGrant, signGrant, signConsumerRequest } from '../../grant.js'
import {
  applyDisclosureGates,
  type GateChainResult,
  type ReadInPlaceFetcher,
  type ReadRequest,
} from '../../gate-engine.js'
import { emitSubjectAddressedReceipt, verifySubjectAddressedReceipt, type Receipt } from '../../receipt.js'
import { acceptDisclosure } from '../../consume.js'
import type { Frame, Lens, ScopeExpression } from '../../types.js'

/**
 * Case 16 — SP-4: symmetric read-in-place over subject-held substrate.
 *
 * Spec: docs/specifications/SLF-SOVEREIGNTY-CONFORMANCE-PROFILE-v0.1-2026-06-20.md §SP-4.
 * Design: docs/architecture/SLF-SP4-DESIGN-symmetric-read-in-place-2026-06-20.md.
 *
 * The engine MUST operate identically whether the substrate is issuer-held or
 * subject-held. The substrate boundary is the fetcher: an issuer-held read hands
 * the engine the full raw substrate (it gates in-process); a subject-held read
 * gates IN PLACE behind the subject's own boundary and releases only the facts
 * that pass — the full substrate never leaves the subject's control.
 *
 * This case proves, with one fact that discloses and one a gate withholds:
 *  - SYMMETRY: the issuer-held and subject-held reads return the identical
 *    outcome and identical disclosed set (the engine "operates identically");
 *  - an EXTERNAL consumer (grant audience != subject), cryptographically bound to
 *    the grant, opens a frame against subject-held substrate and receives a gated,
 *    gate-passing-only read;
 *  - NO FULL COPY crosses the boundary: the engine never calls the copy-out path
 *    (fetchFacts); only the gate-passing fact crosses; and the withheld fact's
 *    private value -- which the issuer-held in-process path DID carry into the
 *    redaction record -- never crosses on the subject-held path (load-bearing,
 *    non-vacuous contrast);
 *  - a RECEIPT is issued to the subject: the engine signs a receipt carrying the
 *    subject reference, and the subject -- holding their own key, never the issuer's
 *    secret -- verifies a subject-addressed copy from public material alone;
 *  - the receipt carries enforcementTier T0 (sovereign self-enforcement, D3/D5) and
 *    a custodian field equal to the subject DID (D5); acceptDisclosure at required
 *    tier T0 accepts it (section 5.4);
 *  - the INVERTED topology (issuer === subject: the individual issues the grant)
 *    reads in place identically.
 */
export const sp4ReadInPlaceCase: ConformanceCase = async () => {
  const enterprise = generateKeyPair() // issuer in the enterprise-held deployment
  const subject = generateKeyPair() // the individual -- holds the substrate and their own key
  const consumer = generateKeyPair() // an external consumer (grant audience), distinct from the subject

  const now = Math.floor(Date.now() / 1000)
  const window = { iat: now - 60, exp: now + 3600 }
  const frameId = 'read-summary'
  const scope: ScopeExpression = { op: 'EQUALS', field: 'entity_type', value: 'fact' }

  const lens: Lens = { id: 'lens-16', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact'] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-summary',
    intent: 'read facts',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameId],
  }

  // The subject's substrate: one fact that discloses, one a restrictive gate tag
  // withholds. SENTINEL is unique so the case can prove it never crosses the boundary.
  const SENTINEL = 'SUBJECT-PRIVATE-9c4f2a'
  const passFact = { id: 'f1', entity_type: 'fact', content: 'a subject summary', domain: 'general' }
  const restrictedFact = {
    id: 'f2',
    entity_type: 'fact',
    content: SENTINEL,
    gates: ['personal-data'],
    domain: 'general',
  }
  const substrate = [passFact, restrictedFact]

  /**
   * A subject-held substrate that gates reads IN PLACE. It evaluates the identical
   * disclosure-governing gates the engine would, behind its own boundary, and
   * releases only the facts that pass. `withheld` carries field-name metadata only
   * (no values). The monitor records what crossed and whether the copy-out path
   * (fetchFacts) was ever demanded.
   */
  interface BoundaryMonitor {
    held: number
    fullCopyRequested: boolean
    crossed: Array<Record<string, unknown>>
  }
  function subjectHeldStore(
    facts: Array<Record<string, unknown>>,
  ): ReadInPlaceFetcher & { monitor: BoundaryMonitor } {
    const monitor: BoundaryMonitor = { held: facts.length, fullCopyRequested: false, crossed: [] }
    return {
      monitor,
      async fetchFacts() {
        // The copy-out path: handing over the full substrate. A read-in-place engine
        // MUST NOT use this for subject-held substrate; we record any attempt.
        monitor.fullCopyRequested = true
        return facts
      },
      async readInPlace(grant, request) {
        const gated = await applyDisclosureGates(grant, request, facts)
        monitor.crossed.push(...gated.disclosed)
        const withheld = gated.redacted.map((r) => ({
          fact: Object.fromEntries(Object.keys(r.fact).map((k) => [k, '<withheld>'])),
          reasonCode: r.reasonCode,
        }))
        return { released: gated.disclosed, withheld, gatesEvaluated: gated.gatesEvaluated }
      },
    }
  }

  // Build + sign a Read grant naming the subject and an explicit external audience.
  async function grantFrom(issuer: { did: string; secretKey: Uint8Array }, audience: string) {
    const g = createGrant({
      issuer: issuer.did,
      audience,
      subject: subject.did,
      scopeExpression: scope,
      allowedFrames: [frameId],
      validity: window,
    })
    return signGrant(g, issuer.secretKey)
  }

  // One consumer-bound guarded read against a given fetcher; returns result + receipt + ctx actor.
  async function read(
    grant: Awaited<ReturnType<typeof grantFrom>>,
    fetcher: Parameters<typeof runGuardedRead>[2],
    requestId: string,
  ): Promise<{ result: GateChainResult; receipt: Receipt | null; ctx: ConformanceContext; actorDid: string }> {
    const { actor, ctx } = newCaseContext()
    const request: ReadRequest = {
      requestId,
      lens,
      frame,
      holderDid: consumer.did,
      consumerRequest: await signConsumerRequest({ requestId, holderDid: consumer.did }, consumer.secretKey),
    }
    const { result, receipt } = await runGuardedRead(grant, request, fetcher, ctx)
    return { result, receipt, ctx, actorDid: actor.did }
  }

  const enterpriseGrant = await grantFrom(enterprise, consumer.did)

  // -- Issuer-held topology: the engine fetches the full raw substrate, gates in-process --
  const issuer = await read(enterpriseGrant, spyFetcher(substrate), 'case-16-issuer')
  const issuerResult = issuer.result

  // -- Subject-held topology: the substrate gates in place; only passing facts cross --
  const store = subjectHeldStore(substrate)
  const subjectRead = await read(enterpriseGrant, store, 'case-16-subject')
  const subjectResult = subjectRead.result

  // -- SYMMETRY: identical outcome and identical disclosed set on both topologies --
  const symmetric =
    issuerResult.outcome === subjectResult.outcome &&
    JSON.stringify(issuerResult.disclosed) === JSON.stringify(subjectResult.disclosed)

  // -- External consumer receives a gated, gate-passing-only read --
  const externalConsumer = consumer.did !== subject.did && enterpriseGrant.audience === consumer.did
  const gatedRead =
    subjectResult.outcome === 'granted' &&
    subjectResult.disclosed.length === 1 &&
    subjectResult.disclosed[0].id === 'f1'

  // -- Gate-passing only: the restricted fact is withheld, never disclosed (non-vacuous) --
  const restrictedWithheld =
    !subjectResult.disclosed.some((f) => f.id === 'f2') &&
    subjectResult.redacted.some((r) => r.reasonCode === 'gate-tag-restricted')

  // -- NO FULL COPY crosses the boundary --
  // The engine never demanded the full substrate; only the passing fact crossed;
  // and the withheld value never crossed on the subject-held path -- while the
  // issuer-held in-process path DID carry it into the redaction record (the
  // load-bearing contrast that makes this non-vacuous).
  const subjectSurface = JSON.stringify({
    disclosed: subjectResult.disclosed,
    redacted: subjectResult.redacted,
    crossed: store.monitor.crossed,
  })
  const issuerCarriedValue = JSON.stringify(issuerResult.redacted).includes(SENTINEL)
  const noFullCopy =
    store.monitor.fullCopyRequested === false &&
    store.monitor.crossed.length === 1 &&
    store.monitor.crossed.length < store.monitor.held &&
    !subjectSurface.includes(SENTINEL) &&
    issuerCarriedValue

  // -- RECEIPT issued to the subject, verifiable by the subject as a non-issuer holder --
  const subjectReceipt = subjectRead.receipt
  const carriesSubject = subjectReceipt?.subjectRef === subject.did
  let receiptToSubjectVerified = false
  let copyAddressedToSubject = false
  let copyCarriesNoIssuerSecret = false
  if (subjectReceipt) {
    const copy = emitSubjectAddressedReceipt(subjectReceipt, subjectRead.actorDid)
    const verdict = await verifySubjectAddressedReceipt(copy)
    receiptToSubjectVerified = verdict.verified === true
    copyAddressedToSubject = copy.subjectRef === subject.did
    // The copy carries the signer's PUBLIC did and never any secret key material.
    copyCarriesNoIssuerSecret = copy.issuerDid === subjectRead.actorDid && !JSON.stringify(copy).includes('"secretKey"')
  }

  // -- SECTION 5.4: enforcementTier T0, custodian = subject DID, acceptDisclosure accepts (D5) --
  const tierIsT0 = subjectReceipt?.enforcementTier === 'T0'
  const custodianIsSubject = subjectReceipt?.custodian === subject.did
  let acceptedAtT0 = false
  if (subjectReceipt) {
    const verdict = await acceptDisclosure(
      { receipt: subjectReceipt, data: subjectResult.disclosed },
      { actorDid: subjectRead.actorDid, requiredTier: 'T0' },
    )
    acceptedAtT0 = verdict.accepted === true
  }

  // -- INVERTED topology (issuer === subject): the individual issues the grant --
  const invertedGrant = await grantFrom(subject, consumer.did)
  const invertedStore = subjectHeldStore(substrate)
  const inverted = await read(invertedGrant, invertedStore, 'case-16-inverted')
  const invertedSymmetric =
    inverted.result.outcome === 'granted' &&
    JSON.stringify(inverted.result.disclosed) === JSON.stringify(subjectResult.disclosed) &&
    invertedStore.monitor.fullCopyRequested === false

  return makeCaseResult(
    '16-sp4-read-in-place',
    'SP-4: the engine reads subject-held substrate in place -- identical to issuer-held, gated, receipted, no full copy crosses',
    [
      { label: 'issuer-held and subject-held reads return the identical outcome and disclosed set (operates identically)', ok: symmetric },
      { label: 'an external consumer (audience != subject) opens a frame and receives a gated read', ok: externalConsumer && gatedRead },
      { label: 'only gate-passing facts cross -- the restricted fact is withheld, never disclosed (non-vacuous)', ok: restrictedWithheld },
      { label: 'no full copy crosses the boundary: the copy-out path is never called and the withheld value never crosses (load-bearing)', ok: noFullCopy },
      { label: 'a receipt is issued to the subject (carries the subject reference)', ok: carriesSubject === true },
      { label: 'the subject verifies a subject-addressed receipt copy from public material alone (no issuer secret)', ok: receiptToSubjectVerified && copyAddressedToSubject && copyCarriesNoIssuerSecret },
      { label: 'receipt carries enforcementTier T0 (sovereign self-enforcement, D3/D5)', ok: tierIsT0 },
      { label: 'receipt custodian field is the subject DID (D5)', ok: custodianIsSubject },
      { label: 'acceptDisclosure at required tier T0 accepts the disclosure (section 5.4)', ok: acceptedAtT0 },
      { label: 'the inverted topology (issuer === subject) reads in place identically', ok: invertedSymmetric },
    ],
  )
}
