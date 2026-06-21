import { CASES, run } from '../bin/slf-conformance.js'
import { runConformanceSuite, type SuiteResult } from '../src/conformance/harness.js'
import { candidateDbPaths, loadRealCorpus } from '../src/conformance/real-corpus.js'
import { skipEvalDetectedCase } from '../src/conformance/cases/07-skip-eval-detected.js'
import { suppressedReceiptRejectedCase } from '../src/conformance/cases/08-suppressed-receipt-rejected.js'
import { tierClaimMismatchCase } from '../src/conformance/cases/09-tier-claim-mismatch.js'

// The Case-B threat-model cases (PCC-2849) extend the SLF-4 suite. They are
// wired in here rather than in bin/slf-conformance.ts so the executable suite
// stays the SLF-4 artifact while these run as part of the test gate.
const THREAT_MODEL_CASES = [
  skipEvalDetectedCase,
  suppressedReceiptRejectedCase,
  tierClaimMismatchCase,
]

describe('SLF conformance suite', () => {
  let suite: SuiteResult

  beforeAll(async () => {
    suite = await runConformanceSuite([...CASES, ...THREAT_MODEL_CASES])
  })

  it('runs at least six cases and the suite is green (exits zero)', async () => {
    expect(suite.results.length).toBeGreaterThanOrEqual(6)
    expect(suite.failedCount).toBe(0)
    expect(suite.passed).toBe(true)

    const code = await run(CASES)
    expect(code).toBe(0)
  })

  it.each([
    '01-valid-grant',
    '02-expired-grant',
    '03-gate-redaction',
    '04-frame-not-authorized',
    '05-tampered-grant',
    '06-hitl-approval',
  ])('case %s passes', (id) => {
    const c = suite.results.find((r) => r.id === id)
    expect(c).toBeDefined()
    expect(c?.passed).toBe(true)
  })

  it('case 05 tampered grant fails before any read (reader never invoked)', () => {
    const c = suite.results.find((r) => r.id === '05-tampered-grant')
    expect(c?.passed).toBe(true)
    const readerAssertion = c?.assertions.find((a) => /reader never invoked/i.test(a.label))
    expect(readerAssertion?.ok).toBe(true)
  })

  it('case 06 HITL pauses then completes on an approval token', () => {
    const c = suite.results.find((r) => r.id === '06-hitl-approval')
    expect(c?.passed).toBe(true)
    expect(c?.assertions.find((a) => /pending_approval/i.test(a.label))?.ok).toBe(true)
    expect(c?.assertions.find((a) => /token completes the read/i.test(a.label))?.ok).toBe(true)
  })

  it.each([
    '07-skip-eval-detected',
    '08-suppressed-receipt-rejected',
    '09-tier-claim-mismatch',
  ])('threat-model case %s passes', (id) => {
    const c = suite.results.find((r) => r.id === id)
    expect(c).toBeDefined()
    expect(c?.passed).toBe(true)
  })

  it('case 07 fails a skip-evaluation forgery despite a valid signature', () => {
    const c = suite.results.find((r) => r.id === '07-skip-eval-detected')
    expect(c?.passed).toBe(true)
    expect(c?.assertions.find((a) => /FAILS verification/i.test(a.label))?.ok).toBe(true)
  })

  it('case 08 refuses a suppressed receipt at the consuming side', () => {
    const c = suite.results.find((r) => r.id === '08-suppressed-receipt-rejected')
    expect(c?.passed).toBe(true)
    expect(c?.assertions.find((a) => /suppressed/i.test(a.label))?.ok).toBe(true)
  })

  it('case 09 rejects a T3 receipt claiming a T0 prevention guarantee', () => {
    const c = suite.results.find((r) => r.id === '09-tier-claim-mismatch')
    expect(c?.passed).toBe(true)
    expect(c?.assertions.find((a) => /CANNOT claim a T0/i.test(a.label))?.ok).toBe(true)
  })

  it('runs one case against a read-only snapshot of real Alexandria lessons', async () => {
    const snapshot = await loadRealCorpus({ limit: 50 })

    if (snapshot.available) {
      // The corpus is present on this host — prove we actually read real rows, read-only.
      expect(snapshot.readonly).toBe(true)
      expect(snapshot.source).toBeTruthy()
      expect(snapshot.rowCount).toBeGreaterThan(0)
    } else {
      // No corpus on this host — the loader degrades cleanly; log what was checked.
      // eslint-disable-next-line no-console
      console.warn('real corpus unavailable; checked:', candidateDbPaths().join(', '))
    }

    const c = suite.results.find((r) => r.id === 'real-corpus')
    expect(c).toBeDefined()
    expect(c?.passed).toBe(true)
    // If the corpus exists, the case must have actually run against it (not skipped).
    if (snapshot.available) {
      expect(c?.skipped).not.toBe(true)
    }
  })

  // ── SLF-7 adversarial leak cases (PCC-2865) ──────────────────────────────

  it.each([
    '10-canary-exfiltration',
    '11-cross-tenant-isolation',
  ])('leak conformance case %s passes with zero leak rate', (id) => {
    const c = suite.results.find((r) => r.id === id)
    expect(c).toBeDefined()
    expect(c?.passed).toBe(true)
  })

  it('case 10 reports a zero canary leak rate over the full adversarial corpus', () => {
    const c = suite.results.find((r) => r.id === '10-canary-exfiltration')
    expect(c?.passed).toBe(true)
    const leakAssertion = c?.assertions.find((a) => /zero canary disclosures/i.test(a.label))
    expect(leakAssertion?.ok).toBe(true)
  })

  it('case 10 corpus is loaded with at least 30 adversarial variants', () => {
    const c = suite.results.find((r) => r.id === '10-canary-exfiltration')
    expect(c?.passed).toBe(true)
    const corpusAssertion = c?.assertions.find((a) => /corpus loaded/i.test(a.label))
    expect(corpusAssertion?.ok).toBe(true)
  })

  it('case 10 records a substrate-gate canary exclusion (exclusion is receipted)', () => {
    const c = suite.results.find((r) => r.id === '10-canary-exfiltration')
    expect(c?.passed).toBe(true)
    const exclusionAssertion = c?.assertions.find((a) => /substrate-gate canary exclusion/i.test(a.label))
    expect(exclusionAssertion?.ok).toBe(true)
  })

  it('case 11 confirms Tenant A can access the canary (non-vacuous isolation proof)', () => {
    const c = suite.results.find((r) => r.id === '11-cross-tenant-isolation')
    expect(c?.passed).toBe(true)
    const aCanAssertion = c?.assertions.find((a) => /Tenant A can legitimately read/i.test(a.label))
    expect(aCanAssertion?.ok).toBe(true)
  })

  it('case 11 reports zero cross-tenant canary disclosures', () => {
    const c = suite.results.find((r) => r.id === '11-cross-tenant-isolation')
    expect(c?.passed).toBe(true)
    const leakAssertion = c?.assertions.find((a) => /zero cross-tenant canary disclosures/i.test(a.label))
    expect(leakAssertion?.ok).toBe(true)
  })
})
