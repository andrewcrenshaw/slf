import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGrant, signGrant, verifyGrant } from '../grant.js'
import { generateKeyPair } from '../did-key.js'
import {
  evaluateGateChainWithReceipt,
  type ReadRequest,
  type SubstrateFetcher,
  type GateChainResult,
} from '../gate-engine.js'
import { buildReceipt, signReceipt, type Receipt } from '../receipt.js'
import { InMemoryReceiptStore, type ReceiptStore } from '../receipt-store.js'
import type { Grant, GateOutcome, KeyPair, ScopeExpression } from '../types.js'

export { verifyReceipt } from '../receipt.js'

/** One named assertion inside a conformance case. */
export interface Assertion {
  label: string
  ok: boolean
}

/** The result of running one conformance case. */
export interface CaseResult {
  id: string
  title: string
  /** true iff every assertion held. A skipped case is non-failing and reports passed:true. */
  passed: boolean
  /** Set when a case could not run (e.g. real corpus absent); still counts as non-failing. */
  skipped?: boolean
  detail: string
  assertions: Assertion[]
}

/** A conformance case is a self-contained async function returning its result. */
export type ConformanceCase = () => Promise<CaseResult>

/** Build a CaseResult from a list of assertions; passed iff every assertion is ok. */
export function makeCaseResult(
  id: string,
  title: string,
  assertions: Assertion[],
  detail = '',
): CaseResult {
  return { id, title, passed: assertions.every((a) => a.ok), detail, assertions }
}

/** A non-failing case that did not run (informational; logged, never silent). */
export function makeSkippedCase(id: string, title: string, detail: string): CaseResult {
  return { id, title, passed: true, skipped: true, detail, assertions: [] }
}

/** Context threaded through a guarded read: receipt store + actor key + injectable clock. */
export interface ConformanceContext {
  store: ReceiptStore
  actorSecretKey: Uint8Array
  /** Clock injection for deterministic receipts; defaults to Date.now. */
  now?: () => number
}

export interface GuardedReadResult {
  result: GateChainResult
  receipt: Receipt | null
  /** false iff the substrate reader was never touched (short-circuit on an invalid grant). */
  readerInvoked: boolean
}

/** Map a failed grant-verification reason to a terminal gate outcome. */
function outcomeForInvalidGrant(reason: string | undefined): GateOutcome {
  // An expired grant is a policy denial; a bad/absent signature is an integrity error.
  return reason === 'grant-expired' ? 'denied' : 'error'
}

/**
 * A grant-verifying read. The grant signature and validity window are checked
 * BEFORE the substrate reader is touched. An invalid grant short-circuits to a
 * terminal outcome — `denied` for an expired grant, `error` for a tampered or
 * absent signature — emits exactly one signed, hash-chained receipt, and never
 * invokes the reader. A valid grant runs the full SLF-2 gate chain through the
 * SLF-3 receipt-emitting engine.
 *
 * This is the SLF round-trip the conformance suite exercises: nothing is read
 * until the grant proves itself.
 */
export async function runGuardedRead(
  grant: Grant,
  request: ReadRequest,
  fetcher: SubstrateFetcher,
  ctx: ConformanceContext,
): Promise<GuardedReadResult> {
  const verdict = await verifyGrant(grant)
  if (!verdict.valid) {
    const result: GateChainResult = {
      outcome: outcomeForInvalidGrant(verdict.reason),
      disclosed: [],
      redacted: [],
      gatesEvaluated: [],
      reasonCode: verdict.reason ?? 'grant-verification-failed',
    }
    const previous = await ctx.store.head()
    const timestamp = (ctx.now ?? Date.now)()
    const unsigned = buildReceipt(result, grant, {
      timestamp,
      prevReceiptId: previous?.id,
      chainId: previous?.chainId,
    })
    const receipt = await signReceipt(unsigned, ctx.actorSecretKey)
    await ctx.store.append(receipt)
    return { result, receipt, readerInvoked: false }
  }

  const { result, receipt } = await evaluateGateChainWithReceipt(grant, request, fetcher, ctx)
  return { result, receipt, readerInvoked: true }
}

/** A substrate fetcher that records how many times it was invoked (case 05 spy). */
export interface SpyFetcher extends SubstrateFetcher {
  readonly invocations: number
}

/** Wrap a static set of facts so the harness can assert the reader was (not) invoked. */
export function spyFetcher(facts: Array<Record<string, unknown>>): SpyFetcher {
  let invocations = 0
  return {
    get invocations() {
      return invocations
    },
    async fetchFacts() {
      invocations += 1
      return facts
    },
  }
}

/** Fresh actor keypair + in-memory receipt store + fixed clock for one case. */
export function newCaseContext(now = 1_780_000_000_000): { actor: KeyPair; ctx: ConformanceContext } {
  const actor = generateKeyPair()
  const ctx: ConformanceContext = {
    store: new InMemoryReceiptStore(),
    actorSecretKey: actor.secretKey,
    now: () => now,
  }
  return { actor, ctx }
}

/** Create and sign a Read grant in one step (issuer DID must own `secretKey`). */
export async function buildSignedGrant(params: {
  issuer: string
  secretKey: Uint8Array
  scopeExpression: ScopeExpression
  allowedFrames: string[]
  iat: number
  exp: number
  /** SP-3 (D1) data subject DID the grant concerns; omitted -> subjectless grant. */
  subject?: string
}): Promise<Grant> {
  const grant = createGrant({
    issuer: params.issuer,
    // Conformance grants are self-issued by the actor; the audience (grant
    // recipient) is a distinct notional consumer DID, so the field consistently
    // names the grantee, never the issuer (PCC-2927).
    audience: 'did:key:z6MkConformanceConsumer',
    scopeExpression: params.scopeExpression,
    allowedFrames: params.allowedFrames,
    validity: { iat: params.iat, exp: params.exp },
    subject: params.subject,
  })
  return signGrant(grant, params.secretKey)
}

/** Flip the first (fully-significant) character of a compact-JWS signature segment. */
export function tamperSignature(jws: string): string {
  const parts = jws.split('.')
  const sig = parts[2] ?? ''
  const first = sig.charAt(0)
  parts[2] = (first === 'A' ? 'B' : 'A') + sig.slice(1)
  return parts.join('.')
}

/**
 * Load the published adversarial leak corpus (src/conformance/leak-corpus.json),
 * shared by the SLF-7 leak cases (10, 11).
 *
 * The path is resolved WITHOUT `import.meta` so this module parses under both
 * runtimes the suite runs in: the Jest CJS transform injects `__dirname` (this
 * file's real directory) and rejects a literal `import.meta` token, while
 * `npx tsx bin/slf-conformance.ts` runs as ESM from the package root where
 * `__dirname` is undefined. See bin/slf-conformance.ts for the same constraint.
 */
export function loadLeakCorpus(): ReadRequest[] {
  const dir =
    typeof __dirname !== 'undefined' ? __dirname : join(process.cwd(), 'src/conformance')
  return JSON.parse(readFileSync(join(dir, 'leak-corpus.json'), 'utf-8')) as ReadRequest[]
}

export interface SuiteResult {
  passed: boolean
  total: number
  passedCount: number
  failedCount: number
  skippedCount: number
  results: CaseResult[]
}

/** Run every case in order; the suite passes iff no case failed (skips are OK). */
export async function runConformanceSuite(cases: ConformanceCase[]): Promise<SuiteResult> {
  const results: CaseResult[] = []
  for (const c of cases) {
    results.push(await c())
  }
  const failedCount = results.filter((r) => !r.passed).length
  const skippedCount = results.filter((r) => r.skipped === true).length
  const passedCount = results.filter((r) => r.passed && r.skipped !== true).length
  return {
    passed: failedCount === 0,
    total: results.length,
    passedCount,
    failedCount,
    skippedCount,
    results,
  }
}
