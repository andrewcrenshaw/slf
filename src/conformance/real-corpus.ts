import { existsSync } from 'node:fs'
import {
  buildSignedGrant,
  makeCaseResult,
  makeSkippedCase,
  newCaseContext,
  runGuardedRead,
  spyFetcher,
  verifyReceipt,
  type ConformanceCase,
} from './harness.js'
import type { Frame, Lens } from '../types.js'

/** A point-in-time, read-only view of real Alexandria `lessons` rows. */
export interface RealCorpusSnapshot {
  available: boolean
  source: string | null
  /** Always true: the snapshot is opened with SQLITE_OPEN_READONLY (mode=ro). */
  readonly: boolean
  rowCount: number
  facts: Array<Record<string, unknown>>
}

/**
 * Location of the corpus to exercise this case against, supplied by the host
 * via the `ALEXANDRIA_DB_PATH` environment variable. It must point at a SQLite
 * database exposing a `lessons` table (id, entity_type, content|summary,
 * domain), opened read-only and never written. When the variable is unset — the
 * default for any clone or CI runner — no corpus is found and the case skips.
 */
export function candidateDbPaths(): string[] {
  const fromEnv = process.env.ALEXANDRIA_DB_PATH
  return fromEnv ? [fromEnv] : []
}

/**
 * Load a read-only snapshot of real `lessons` rows mapped into the engine's fact
 * shape (id, entity_type, content, domain). better-sqlite3 is loaded lazily so
 * slf-core carries no hard dependency on it — when the driver or the corpus is
 * absent the snapshot reports `available:false` and the case degrades to a skip.
 *
 * The DB is opened with `{ readonly: true }` (SQLITE_OPEN_READONLY): the
 * conformance suite never writes to the real corpus.
 */
export async function loadRealCorpus(opts: { limit?: number } = {}): Promise<RealCorpusSnapshot> {
  const limit = opts.limit ?? 200
  const unavailable = (source: string | null): RealCorpusSnapshot => ({
    available: false,
    source,
    readonly: true,
    rowCount: 0,
    facts: [],
  })

  const path = candidateDbPaths().find((p) => p && existsSync(p))
  if (!path) return unavailable(null)

  let Database: unknown
  try {
    const mod = (await import('better-sqlite3')) as { default?: unknown }
    Database = mod.default ?? mod
  } catch {
    return unavailable(path)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = Database as new (p: string, o: Record<string, unknown>) => any
  let db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }; close: () => void }
  try {
    db = new Ctor(path, { readonly: true, fileMustExist: true })
  } catch {
    return unavailable(path)
  }

  try {
    const hasLessons = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lessons'")
      .get()
    if (!hasLessons) return unavailable(path)

    const rows = db
      .prepare(
        `SELECT id, entity_type, COALESCE(content, summary, '') AS content, domain
           FROM lessons
          WHERE entity_type IS NOT NULL
            AND COALESCE(content, summary, '') <> ''
          LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>

    const facts = rows.map((r) => ({
      id: r.id,
      entity_type: r.entity_type,
      content: r.content,
      domain: r.domain ?? 'general',
    }))
    return { available: true, source: path, readonly: true, rowCount: facts.length, facts }
  } finally {
    db.close()
  }
}

/** The most common entity_type among snapshot rows (self-calibrates the grant scope). */
export function dominantEntityType(facts: Array<Record<string, unknown>>): string | null {
  const counts = new Map<string, number>()
  for (const f of facts) {
    const t = typeof f.entity_type === 'string' ? f.entity_type : ''
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [t, n] of counts) {
    if (n > bestN) {
      best = t
      bestN = n
    }
  }
  return best
}

/**
 * The "not a toy" case: run the gate chain against a read-only snapshot of real
 * Alexandria lessons. The grant scope self-calibrates to the most common real
 * entity_type so the case stays green as the corpus evolves; it asserts the
 * engine discloses exactly the in-scope rows and emits a verifiable receipt.
 *
 * If no readable corpus is present on the host, the case skips (logged, never a
 * silent pass) rather than failing — real data is exercised wherever it exists.
 */
export const realCorpusCase: ConformanceCase = async () => {
  const id = 'real-corpus'
  const title = 'Read enforced against a read-only snapshot of real Alexandria lessons'

  const snapshot = await loadRealCorpus({ limit: 200 })
  if (!snapshot.available || snapshot.facts.length === 0) {
    return makeSkippedCase(
      id,
      title,
      `skipped — no readable Alexandria lessons corpus found (looked in: ${candidateDbPaths().join(', ')}). ` +
        'Informational only: this case exercises real data wherever the corpus is present.',
    )
  }

  const entityType = dominantEntityType(snapshot.facts) ?? 'fact'
  const { actor, ctx } = newCaseContext()
  const now = Math.floor(Date.now() / 1000)
  const frameId = 'read-corpus-summary'

  const grant = await buildSignedGrant({
    issuer: actor.did,
    secretKey: actor.secretKey,
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: entityType },
    allowedFrames: [frameId],
    iat: now - 60,
    exp: now + 3600,
  })
  const lens: Lens = { id: 'lens-corpus', role: 'analyst', jurisdiction: 'us', entityTypes: [entityType] }
  const frame: Frame = {
    id: frameId,
    taskSlug: 'read-corpus',
    intent: 'read real lessons',
    nextStep: 'review',
    requiresApproval: false,
    allowedFrames: [frameId],
  }

  const fetcher = spyFetcher(snapshot.facts)
  const { result, receipt, readerInvoked } = await runGuardedRead(
    grant,
    { requestId: 'real-corpus', lens, frame },
    fetcher,
    ctx,
  )

  const expectedDisclosed = snapshot.facts.filter((f) => f.entity_type === entityType).length
  const verified = receipt ? await verifyReceipt(receipt, actor.did) : false

  return makeCaseResult(
    id,
    title,
    [
      { label: `read a real Alexandria DB (${snapshot.source})`, ok: snapshot.source !== null },
      { label: 'corpus opened read-only (mode=ro)', ok: snapshot.readonly === true },
      { label: `snapshot has real rows (${snapshot.rowCount})`, ok: snapshot.rowCount > 0 },
      { label: 'reader invoked under a valid grant', ok: readerInvoked === true },
      { label: 'gate chain granted on real rows', ok: result.outcome === 'granted' },
      {
        label: `disclosed exactly the in-scope entity_type=${entityType} rows (${result.disclosed.length})`,
        ok: result.disclosed.length === expectedDisclosed && result.disclosed.length > 0,
      },
      {
        label: 'every disclosed row matches the grant scope',
        ok: result.disclosed.every((f) => f.entity_type === entityType),
      },
      {
        label: 'emitted a verifiable granted receipt',
        ok: receipt !== null && receipt.outcome === 'granted' && verified,
      },
    ],
    `source=${snapshot.source} rows=${snapshot.rowCount} entityType=${entityType} disclosed=${result.disclosed.length}`,
  )
}
