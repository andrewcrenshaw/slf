import { generateKeyPair } from '../src/did-key.js'
import { signJWS, verifyJWS } from '../src/signing.js'
import { createHash } from 'node:crypto'

export interface CryptoBenchResult {
  ed25519Sign: { p50: number; p95: number; p99: number }
  ed25519Verify: { p50: number; p95: number; p99: number }
  sha256: { p50: number; p95: number; p99: number }
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

export async function runCryptoBench(opts?: { iterations?: number }): Promise<CryptoBenchResult> {
  const N = opts?.iterations ?? 1000
  const kp = generateKeyPair()
  const payload = { sub: 'bench', action: 'read', ts: 1000 }

  // --- Ed25519 sign ---
  const signSamples: number[] = []
  for (let i = 0; i < N; i++) {
    const s = process.hrtime() as [number, number]
    await signJWS(payload, kp.secretKey)
    const e = process.hrtime() as [number, number]
    signSamples.push(toMicros(s, e))
  }

  // --- Ed25519 verify ---
  const jws = await signJWS(payload, kp.secretKey)
  const verifySamples: number[] = []
  for (let i = 0; i < N; i++) {
    const s = process.hrtime() as [number, number]
    await verifyJWS(jws, kp.did)
    const e = process.hrtime() as [number, number]
    verifySamples.push(toMicros(s, e))
  }

  // --- SHA-256 (Node built-in) ---
  const sha256Samples: number[] = []
  const testData = Buffer.from('bench-data-for-sha256-latency-measurement')
  for (let i = 0; i < N * 10; i++) {
    const s = process.hrtime() as [number, number]
    createHash('sha256').update(testData).digest()
    const e = process.hrtime() as [number, number]
    sha256Samples.push(toMicros(s, e))
  }

  return {
    ed25519Sign: {
      p50: percentile(signSamples, 50),
      p95: percentile(signSamples, 95),
      p99: percentile(signSamples, 99),
    },
    ed25519Verify: {
      p50: percentile(verifySamples, 50),
      p95: percentile(verifySamples, 95),
      p99: percentile(verifySamples, 99),
    },
    sha256: {
      p50: percentile(sha256Samples, 50),
      p95: percentile(sha256Samples, 95),
      p99: percentile(sha256Samples, 99),
    },
  }
}
