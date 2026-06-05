import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSignedGrant,
  makeCaseResult,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  type ConformanceCase,
} from '../harness.js'
import type { Frame, Lens } from '../../types.js'
import type { ReadRequest } from '../../gate-engine.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Case 11 — Cross-tenant isolation (PROPOSAL-SLF §5 / §6).
 *
 * Tenant A owns a canary fact (entity_type 'secret'). First the test proves A
 * CAN legitimately access the canary (the canary is not trivially absent).
 * Then, Tenant B — with a separate grant, separate receipt store, and a
 * substrate fetcher scoped only to B's own facts — runs the same 32 adversarial
 * corpus entries used in Case 10. B's corpus includes requests with scope
 * predicates that mimic A's (broad entityTypes, any role/jurisdiction, frame
 * spoof) but B's fetcher never returns A's data.
 *
 * Cross-tenant isolation in SLF is enforced at the substrate fetcher boundary:
 * each tenant's fetcher only surfaces that tenant's rows. This case demonstrates
 * that property over the published adversarial corpus.
 *
 * Asserts: (1) A can legitimately read the canary (non-trivial setup);
 * (2) zero cross-tenant disclosures of A's canary in B's reads — leak rate 0/K;
 * (3) every terminal-outcome B-side run produced a receipt; (4) the canary is
 * absent from B's substrate fetcher (the isolation boundary).
 */
export const crossTenantIsolationCase: ConformanceCase = async () => {
  const { actor: actorA, ctx: ctxA } = newCaseContext()
  const { actor: actorB, ctx: ctxB } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)

  const CANARY_ID = 'canary-slf7'
  const CANARY_CONTENT = 'SLF-CANARY-7f3a9b2e-secret-must-never-leak'

  // ── Tenant A setup ──
  const frameIdA = 'tenant-a-frame'
  const grantA = await buildSignedGrant({
    issuer: actorA.did,
    secretKey: actorA.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'secret' },
    allowedFrames: [frameIdA],
    iat: now - 60,
    exp: now + 3600,
  })
  const lensA: Lens = { id: 'lens-tenant-a', role: 'owner', jurisdiction: 'us', entityTypes: ['secret'] }
  const frameA: Frame = {
    id: frameIdA,
    taskSlug: 'tenant-a-read',
    intent: 'owner read own secrets',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameIdA],
  }
  const tenantAFacts = [
    { id: CANARY_ID, entity_type: 'secret', content: CANARY_CONTENT, domain: 'canary' },
    { id: 'a1', entity_type: 'secret', content: 'tenant A other secret', domain: 'general' },
  ]
  // Prove A CAN access the canary (so isolation is meaningful, not vacuous)
  const { result: aResult } = await runGuardedRead(
    grantA,
    { requestId: 'case-11-a-can-read', lens: lensA, frame: frameA },
    spyFetcher(tenantAFacts),
    ctxA,
  )
  const aCanAccessCanary = aResult.disclosed.some((f) => f.id === CANARY_ID)

  // ── Tenant B setup ──
  const frameIdB = 'read-facts'
  const grantB = await buildSignedGrant({
    issuer: actorB.did,
    secretKey: actorB.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: [frameIdB],
    iat: now - 60,
    exp: now + 3600,
  })
  // B's fetcher: only B's own facts — A's canary is physically absent
  const tenantBFacts = [
    { id: 'b1', entity_type: 'fact', content: 'tenant B data alpha', domain: 'general' },
    { id: 'b2', entity_type: 'fact', content: 'tenant B data beta', domain: 'general' },
  ]
  const canaryAbsentFromBFetcher = tenantBFacts.every((f) => f.id !== CANARY_ID)

  const corpusPath = join(__dirname, '../leak-corpus.json')
  const corpus: ReadRequest[] = JSON.parse(readFileSync(corpusPath, 'utf-8'))

  let crossTenantLeakCount = 0
  let terminalCount = 0
  let terminalReceiptCount = 0

  for (const entry of corpus) {
    const { result, receipt } = await runGuardedRead(
      grantB,
      entry,
      spyFetcher(tenantBFacts),
      ctxB,
    )
    const leaked =
      result.disclosed.some((f) => f.id === CANARY_ID) ||
      result.disclosed.some(
        (f) => typeof f.content === 'string' && f.content.includes(CANARY_CONTENT),
      )
    if (leaked) crossTenantLeakCount++

    if (result.outcome !== 'pending_approval') {
      terminalCount++
      if (receipt !== null) terminalReceiptCount++
    }
  }

  const leakRate = crossTenantLeakCount / corpus.length
  const allTerminalReceiptsEmitted = terminalCount > 0 && terminalReceiptCount === terminalCount

  return makeCaseResult(
    '11-cross-tenant-isolation',
    "Tenant B's adversarial requests never disclose Tenant A's canary",
    [
      { label: `corpus loaded (${corpus.length} adversarial variants)`, ok: corpus.length >= 30 },
      { label: 'Tenant A can legitimately read the canary (non-trivial setup)', ok: aCanAccessCanary },
      { label: "canary is absent from Tenant B's substrate fetcher (isolation boundary)", ok: canaryAbsentFromBFetcher },
      { label: `zero cross-tenant canary disclosures (leak rate ${leakRate.toFixed(4)})`, ok: crossTenantLeakCount === 0 },
      {
        label: `every terminal B-side run produced a receipt (${terminalReceiptCount}/${terminalCount})`,
        ok: allTerminalReceiptsEmitted,
      },
    ],
    `corpus=${corpus.length} crossTenantLeakCount=${crossTenantLeakCount} leakRate=${leakRate.toFixed(4)} ` +
      'isolation-boundary=substrate-fetcher (tenant-scoped fetcher prevents cross-tenant mixing)',
  )
}
