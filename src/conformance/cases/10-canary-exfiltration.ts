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
 * A canary fact whose entity_type ('secret') is excluded by both the grant's
 * scopeExpression and the baseline lens entityTypes is seeded into the substrate
 * alongside ordinary facts. A battery of 32 adversarial request variants from
 * the published leak-corpus.json — scope-broadening, role-spoof, multi-field
 * probes, approval-token bypass, frame-ID spoof, and combined multi-vector
 * attacks — is driven against the real gate chain via runGuardedRead.
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
 * triggers a substrate-gate exclusion recording the canary in redacted[].
 */
export const canaryExfiltrationCase: ConformanceCase = async () => {
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-facts'

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

  return makeCaseResult(
    '10-canary-exfiltration',
    'A gate-excluded canary never leaks through any lens across a published adversarial corpus',
    [
      { label: `corpus loaded (${corpus.length} adversarial variants)`, ok: corpus.length >= 30 },
      { label: `zero canary disclosures (leak rate ${leakRate.toFixed(4)})`, ok: leakCount === 0 },
      {
        label: `every terminal-outcome run produced a receipt (${terminalReceiptCount}/${terminalCount})`,
        ok: allTerminalReceiptsEmitted,
      },
      { label: 'at least one run triggered a substrate-gate canary exclusion', ok: substrateExclusionSeen },
    ],
    `corpus=${corpus.length} leakCount=${leakCount} leakRate=${leakRate.toFixed(4)} ` +
      'scope=post-injection-structured-requests (slf-core does not defend LLM prompt boundary)',
  )
}
