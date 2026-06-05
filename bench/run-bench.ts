import { runBench } from './gate-engine.bench.js'
import { runCryptoBench } from './crypto-microbench.js'

async function main(): Promise<void> {
  const N = parseInt(process.argv[2] ?? '10000', 10)
  console.log(`\nSLF-core benchmark — ${N.toLocaleString()} iterations\n`)

  console.log('Running gate-engine bench...') 
  const bench = await runBench({ iterations: N })

  console.log('Running crypto microbench...')
  const crypto = await runCryptoBench({ iterations: Math.min(N, 1000) })

  const fmt = (n: number): string => `${n.toFixed(1)} μs`

  console.log('\n## Gate engine latency\n')
  console.log(`| path        | cache | p50          | p95          | p99          | ops/s        |`)
  console.log(`|-------------|-------|--------------|--------------|--------------|--------------|`)
  console.log(`| read        | warm  | ${fmt(bench.warmCache.p50).padEnd(12)} | ${fmt(bench.warmCache.p95).padEnd(12)} | ${fmt(bench.warmCache.p99).padEnd(12)} | ${bench.warmCache.opsPerSec.toLocaleString().padEnd(12)} |`)
  console.log(`| read        | cold  | ${fmt(bench.coldCache.p50).padEnd(12)} | ${fmt(bench.coldCache.p95).padEnd(12)} | ${fmt(bench.coldCache.p99).padEnd(12)} | ${bench.coldCache.opsPerSec.toLocaleString().padEnd(12)} |`)
  console.log(`| write       | warm  | ${fmt(bench.writePath.p50).padEnd(12)} | ${fmt(bench.writePath.p95).padEnd(12)} | ${fmt(bench.writePath.p99).padEnd(12)} | ${bench.writePath.opsPerSec.toLocaleString().padEnd(12)} |`)

  console.log(`\nWrite-amplification factor: ${bench.writeAmplification.toFixed(2)}\u00d7`)
  console.log(`  (read ops/s ${bench.warmCache.opsPerSec.toLocaleString()} / write ops/s ${bench.writePath.opsPerSec.toLocaleString()})`)

  console.log('\n## Crypto microbench\n')
  console.log(`| operation       | p50          | p95          | p99          |`)
  console.log(`|-----------------|--------------|--------------|--------------|`)
  console.log(`| Ed25519 sign    | ${fmt(crypto.ed25519Sign.p50).padEnd(12)} | ${fmt(crypto.ed25519Sign.p95).padEnd(12)} | ${fmt(crypto.ed25519Sign.p99).padEnd(12)} |`)
  console.log(`| Ed25519 verify  | ${fmt(crypto.ed25519Verify.p50).padEnd(12)} | ${fmt(crypto.ed25519Verify.p95).padEnd(12)} | ${fmt(crypto.ed25519Verify.p99).padEnd(12)} |`)
  console.log(`| SHA-256         | ${fmt(crypto.sha256.p50).padEnd(12)} | ${fmt(crypto.sha256.p95).padEnd(12)} | ${fmt(crypto.sha256.p99).padEnd(12)} |`)

  const midpointRetrievalUs = 7500
  console.log(`\nBaseline: pgvector/HNSW retrieval p95 \u22485\u201320 ms (7.5 ms midpoint)`)
  console.log(`SLF warm-cache gate+crypto overhead as % of retrieval: ${((bench.warmCache.p95 / midpointRetrievalUs) * 100).toFixed(1)}%`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
