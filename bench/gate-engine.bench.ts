import { generateKeyPair } from '../src/did-key.js'
import { createGrant, signGrant } from '../src/grant.js'
import { evaluateGateChain, evaluateGateChainWithReceipt } from '../src/gate-engine.js'
import { InMemoryReceiptStore } from '../src/receipt-store.js'
import { clearGrantCache } from '../src/grant-cache.js'
import type { Grant, Lens, Frame } from '../src/types.js'

const now = Math.floor(Date.now() / 1000)

export interface PercentileSet {
  p50: number
  p95: number
  p99: number
  opsPerSec: number
}

export interface BenchResult {
  warmCache: PercentileSet
  coldCache: PercentileSet
  writePath: PercentileSet
  /** Alias of warmCache for convenience. */
  readPath: PercentileSet
  /** readPath.opsPerSec / writePath.opsPerSec */
  writeAmplification: number
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx] ?? 0
}

function toMicros(start: [number, number], end: [number, number]): number {
  const diffNs = (end[0] - start[0]) * 1e9 + (end[1] - start[1])
  return diffNs / 1e3
}

const lens: Lens = {
  id: 'bench-lens',
  role: 'analyst',
  jurisdiction: 'us',
  entityTypes: ['fact'],
}

const frame: Frame = {
  id: 'bench-frame',
  taskSlug: 'bench',
  intent: 'read',
  nextStep: 'done',
  requiresApproval: false,
  allowedFrames: [],
}

const inlineFetcher = {
  async fetchFacts(_grant: Grant): Promise<Array<Record<string, unknown>>> {
    return [{ id: 'f1', entity_type: 'fact', content: 'bench fact' }]
  },
}

function opsPerSec(samples: number[]): number {
  const totalUs = samples.reduce((a, b) => a + b, 0)
  return totalUs > 0 ? Math.round((samples.length / totalUs) * 1e6) : 0
}

export async function runBench(opts?: { iterations?: number }): Promise<BenchResult> {
  const N = opts?.iterations ?? 10_000
  const kp = generateKeyPair()
  const grant = await signGrant(
    createGrant({
      issuer: kp.did,
      audience: 'did:key:z6BenchAudience',
      scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
      allowedFrames: ['bench-frame'],
      validity: { iat: now - 60, exp: now + 3600 },
    }),
    kp.secretKey,
  )

  // JIT warm-up
  for (let i = 0; i < 50; i++) {
    await evaluateGateChain(grant, { requestId: `w${i}`, lens, frame }, inlineFetcher, { useGrantCache: true })
  }

  // --- Warm-cache read path ---
  clearGrantCache()
  // prime: first call verifies signature and populates cache
  await evaluateGateChain(grant, { requestId: 'prime', lens, frame }, inlineFetcher, { useGrantCache: true })
  const warmSamples: number[] = []
  for (let i = 0; i < N; i++) {
    const s = process.hrtime() as [number, number]
    await evaluateGateChain(grant, { requestId: `warm-${i}`, lens, frame }, inlineFetcher, { useGrantCache: true })
    const e = process.hrtime() as [number, number]
    warmSamples.push(toMicros(s, e))
  }

  // --- Cold-cache read path (clear before each call = fresh Ed25519 verify each time) ---
  const coldN = Math.min(N, 500)
  const coldSamples: number[] = []
  for (let i = 0; i < coldN; i++) {
    clearGrantCache()
    const s = process.hrtime() as [number, number]
    await evaluateGateChain(grant, { requestId: `cold-${i}`, lens, frame }, inlineFetcher, { useGrantCache: true })
    const e = process.hrtime() as [number, number]
    coldSamples.push(toMicros(s, e))
  }

  // --- Write path (evaluateGateChainWithReceipt) ---
  const actor = generateKeyPair()
  const store = new InMemoryReceiptStore()
  const writeN = Math.min(N, 2000)
  const writeSamples: number[] = []
  clearGrantCache()
  // prime cache for write path
  await evaluateGateChain(grant, { requestId: 'write-prime', lens, frame }, inlineFetcher, { useGrantCache: true })
  for (let i = 0; i < writeN; i++) {
    const s = process.hrtime() as [number, number]
    await evaluateGateChainWithReceipt(
      grant,
      { requestId: `write-${i}`, lens, frame },
      inlineFetcher,
      { store, actorSecretKey: actor.secretKey },
      { useGrantCache: true },
    )
    const e = process.hrtime() as [number, number]
    writeSamples.push(toMicros(s, e))
  }

  const warmResult: PercentileSet = {
    p50: percentile(warmSamples, 50),
    p95: percentile(warmSamples, 95),
    p99: percentile(warmSamples, 99),
    opsPerSec: opsPerSec(warmSamples),
  }
  const coldResult: PercentileSet = {
    p50: percentile(coldSamples, 50),
    p95: percentile(coldSamples, 95),
    p99: percentile(coldSamples, 99),
    opsPerSec: opsPerSec(coldSamples),
  }
  const writeResult: PercentileSet = {
    p50: percentile(writeSamples, 50),
    p95: percentile(writeSamples, 95),
    p99: percentile(writeSamples, 99),
    opsPerSec: opsPerSec(writeSamples),
  }
  const wa = writeResult.opsPerSec > 0 ? warmResult.opsPerSec / writeResult.opsPerSec : 0

  return {
    warmCache: warmResult,
    coldCache: coldResult,
    writePath: writeResult,
    readPath: warmResult,
    writeAmplification: wa,
  }
}
