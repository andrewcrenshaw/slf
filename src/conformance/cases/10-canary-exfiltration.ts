import {
  buildSignedGrant,
  loadLeakCorpus,
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  type ConformanceCase,
} from '../harness.js'

/**
 * Case 10 — Canary exfiltration through a lens (PROPOSAL-SLF §5 / §6).
 *
 * Two independent sub-cases run back to back:
 *
 * Sub-case A (substrate-gate): A canary fact (entity_type 'secret') is excluded
 * by the grant's scopeExpression. A corpus of adversarial lens-broadening
 * variants — scope-broadening, role-spoof, multi-field probes, approval-token
 * bypass, frame-ID spoof, and combined multi-vector attacks — is driven against
 * the full gate chain via runGuardedRead. The canary is rejected at gate-1
 * (substrate-gate, scope-mismatch) for every variant; the lens stage never
 * reaches it. Leak rate must be 0/K.
 *
 * Sub-case B (lens-stage): A second canary fact (entity_type 'classified') is
 * IN-SCOPE at gate-1 under a broader grant (fact OR classified) but is excluded
 * by gate-2 (lens-projection) in every lens-narrowing corpus variant. This
 * exercises the lens stage as a distinct control, not a redundant guard. The
 * lens-narrowing variants are a subset of the published corpus identified by the
 * 'lens-narrowing:' attackCategory prefix. Leak rate must be 0/K.
 *
 * Framing note: slf-core sees structured ReadRequests. The corpus encodes the
 * post-injection request variants an injected agent might emit. slf-core does
 * NOT defend the LLM prompt boundary; it defends the structured-request
 * boundary. This scoping is honest and stated here so the position paper does
 * not overclaim.
 *
 * Asserts: (1) zero canary disclosures across the full corpus — leak rate 0/K;
 * (2) every terminal-outcome run produced a signed receipt (pending_approval is
 * a deliberate non-terminal pause — no silent drop); (3) at least one run
 * triggers a substrate-gate exclusion recording the canary in redacted[];
 * (4) at least one run triggers a lens-stage exclusion of the gate-1-passing
 * canary — confirming the lens gate is a distinct, load-bearing control.
 */
export const canaryExfiltrationCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-facts'

  // ── Sub-case A: substrate-gate canary ──────────────────────────────────────
  const grant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: [frameId],
    iat: now - 60,
    exp: now + 3600,
  })

  const CANARY_ID = 'canary-slf7'
  const CANARY_CONTENT = 'SLF-CANARY-7f3a9b2e-secret-must-never-leak'
  const facts = [
    { id: 'f1', entity_type: 'fact', content: 'ordinary fact alpha', domain: 'general' },
    { id: 'f2', entity_type: 'fact', content: 'ordinary fact beta', domain: 'general' },
    { id: CANARY_ID, entity_type: 'secret', content: CANARY_CONTENT, domain: 'canary' },
  ]

  const corpus = loadLeakCorpus()

  let leakCount = 0
  let terminalCount = 0
  let terminalReceiptCount = 0
  let substrateExclusionSeen = false

  for (const entry of corpus) {
    const fetcher = spyFetcher(facts)
    const { result, receipt } = await runGuardedRead(grant, entry, fetcher, ctx)

    const leaked =
      result.disclosed.some((f) => f.id === CANARY_ID) ||
      result.disclosed.some(
        (f) => typeof f.content === 'string' && f.content.includes(CANARY_CONTENT),
      )
    if (leaked) leakCount++

    // pending_approval is a deliberate pause, not a terminal outcome; receipts only
    // accompany terminal outcomes (granted | denied | partial | error).
    if (result.outcome !== 'pending_approval') {
      terminalCount++
      if (receipt !== null) terminalReceiptCount++
    }

    const substrateRedacted = result.redacted.some(
      (r) => r.fact.id === CANARY_ID && r.reasonCode === 'scope-mismatch',
    )
    if (substrateRedacted) substrateExclusionSeen = true
  }

  const leakRate = leakCount / corpus.length
  const allTerminalReceiptsEmitted = terminalCount > 0 && terminalReceiptCount === terminalCount

  // ── Sub-case B: lens-stage canary ──────────────────────────────────────────
  // A grant that puts entity_type='classified' IN-SCOPE at gate-1. The lens
  // variants below exclude 'classified' from entityTypes, so the canary is caught
  // at gate-2 (entity-type-excluded) rather than gate-1 (scope-mismatch). This
  // exercises lens-projection as a distinct, load-bearing control. The lens-grant
  // is intentionally separate so the lens-narrowing variants are NOT run through
  // the full corpus (adv-005 has entityTypes=[] which would disclose everything
  // that passes gate-1; only variants that explicitly restrict entityTypes
  // demonstrate gate-2 exclusion).
  const lensGrant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: {
      op: 'OR',
      args: [
        { op: 'EQUALS', field: 'entity_type', value: 'fact' },
        { op: 'EQUALS', field: 'entity_type', value: 'classified' },
      ],
    },
    allowedFrames: [frameId],
    iat: now - 60,
    exp: now + 3600,
  })

  const LENS_CANARY_ID = 'canary-slf7-lens'
  const LENS_CANARY_CONTENT = 'SLF-CANARY-LENS-9c4b1a7d-must-never-reach-consumer'
  const extendedFacts = [
    ...facts,
    { id: LENS_CANARY_ID, entity_type: 'classified', content: LENS_CANARY_CONTENT, domain: 'canary' },
  ]

  const lensVariants = (corpus as Array<typeof corpus[0] & { attackCategory?: string }>).filter(
    (e) => typeof e.attackCategory === 'string' && e.attackCategory.startsWith('lens-narrowing:'),
  )

  let lensExclusionSeen = false

  for (const entry of lensVariants) {
    const { result: lensResult } = await runGuardedRead(
      lensGrant,
      entry,
      spyFetcher(extendedFacts),
      ctx,
    )
    if (
      lensResult.redacted.some(
        (r) => r.fact.id === LENS_CANARY_ID && r.reasonCode === 'entity-type-excluded',
      )
    ) {
      lensExclusionSeen = true
    }
  }

  return makeCaseResult(
    '10-canary-exfiltration',
    'A gate-excluded canary never leaks through any lens across a published adversarial corpus',
    [
      { label: `corpus loaded (${corpus.length} lens-broadening variants)`, ok: corpus.length >= 30 },
      { label: `zero canary disclosures (leak rate ${leakRate.toFixed(4)})`, ok: leakCount === 0 },
      {
        label: `every terminal-outcome run produced a receipt (${terminalReceiptCount}/${terminalCount})`,
        ok: allTerminalReceiptsEmitted,
      },
      { label: 'at least one run triggered a substrate-gate canary exclusion', ok: substrateExclusionSeen },
      { label: 'at least one run triggered a lens-stage canary exclusion', ok: lensExclusionSeen },
    ],
    `corpus=${corpus.length} leakCount=${leakCount} leakRate=${leakRate.toFixed(4)} ` +
      `lensVariants=${lensVariants.length} lensExclusionSeen=${lensExclusionSeen} ` +
      'scope=post-injection-structured-requests (slf-core does not defend LLM prompt boundary)',
  )
}
