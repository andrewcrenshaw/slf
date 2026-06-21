#!/usr/bin/env node
import {
  runConformanceSuite,
  type ConformanceCase,
  type SuiteResult,
} from '../src/conformance/harness.js'
import { validGrantCase } from '../src/conformance/cases/01-valid-grant.js'
import { expiredGrantCase } from '../src/conformance/cases/02-expired-grant.js'
import { gateRedactionCase } from '../src/conformance/cases/03-gate-redaction.js'
import { frameNotAuthorizedCase } from '../src/conformance/cases/04-frame-not-authorized.js'
import { tamperedGrantCase } from '../src/conformance/cases/05-tampered-grant.js'
import { hitlApprovalCase } from '../src/conformance/cases/06-hitl-approval.js'
import { realCorpusCase } from '../src/conformance/real-corpus.js'
import { canaryExfiltrationCase } from '../src/conformance/cases/10-canary-exfiltration.js'
import { crossTenantIsolationCase } from '../src/conformance/cases/11-cross-tenant-isolation.js'
import { sp1SubjectAddressedReceiptCase } from '../src/conformance/cases/13-sp1-subject-addressed-receipt.js'
import { sp2PortableExportCase } from '../src/conformance/cases/14-sp2-portable-export.js'

/**
 * The full SLF conformance suite: six executable cases plus one case that runs
 * against a read-only snapshot of the real Alexandria corpus, two adversarial
 * leak cases (SLF-7 / PCC-2865), the SP-1 subject-addressability capability case
 * (PCC-3123), and the SP-2 portable-export capability case (PCC-3124). A green run
 * is the artifact that backs the claim "SLF is protected by code, not docs."
 */
export const CASES: ConformanceCase[] = [
  validGrantCase,
  expiredGrantCase,
  gateRedactionCase,
  frameNotAuthorizedCase,
  tamperedGrantCase,
  hitlApprovalCase,
  realCorpusCase,
  canaryExfiltrationCase,
  crossTenantIsolationCase,
  sp1SubjectAddressedReceiptCase,
  sp2PortableExportCase,
]

/** Render a human-readable report of a suite run. */
export function formatReport(suite: SuiteResult): string {
  const lines: string[] = []
  lines.push('SLF conformance suite')
  lines.push('─'.repeat(64))
  for (const r of suite.results) {
    const tag = r.skipped === true ? 'SKIP' : r.passed ? 'PASS' : 'FAIL'
    lines.push(`[${tag}] ${r.id} — ${r.title}`)
    for (const a of r.assertions) {
      lines.push(`        ${a.ok ? '✓' : '✗'} ${a.label}`)
    }
    if (r.detail) lines.push(`        · ${r.detail}`)
  }
  lines.push('─'.repeat(64))
  lines.push(
    `${suite.passedCount} passed, ${suite.failedCount} failed, ${suite.skippedCount} skipped (of ${suite.total})`,
  )
  lines.push(
    suite.passed
      ? 'RESULT: GREEN — SLF is protected by code.'
      : 'RESULT: RED — at least one conformance case failed.',
  )
  return lines.join('\n')
}

/** Run the suite, print the report, and resolve to a process exit code (0 = green). */
export async function run(cases: ConformanceCase[] = CASES): Promise<number> {
  const suite = await runConformanceSuite(cases)
  // eslint-disable-next-line no-console
  console.log(formatReport(suite))
  return suite.passed ? 0 : 1
}

// True when this file is the process entrypoint (e.g. `npx tsx bin/slf-conformance.ts`).
// Uses argv[1] rather than import.meta so the module is importable under both ESM
// (tsx/node) and the CJS transform the test runner applies.
const invokedDirectly = /(?:^|[\\/])slf-conformance\.[cm]?[jt]s$/.test(process.argv[1] ?? '')

if (invokedDirectly) {
  run()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err)
      process.exit(1)
    })
}
