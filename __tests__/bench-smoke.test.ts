import { runBench } from '../bench/gate-engine.bench.js'

describe('bench smoke', () => {
  it('read-path p99 >= p95 >= p50 and all positive', async () => {
    const r = await runBench({ iterations: 200 })

    expect(r.warmCache.p50).toBeGreaterThan(0)
    expect(r.warmCache.p95).toBeGreaterThanOrEqual(r.warmCache.p50)
    expect(r.warmCache.p99).toBeGreaterThanOrEqual(r.warmCache.p95)

    expect(r.coldCache.p50).toBeGreaterThan(0)
    expect(r.coldCache.p95).toBeGreaterThanOrEqual(r.coldCache.p50)
    expect(r.coldCache.p99).toBeGreaterThanOrEqual(r.coldCache.p95)
  }, 30_000)

  it('write-path p99 >= p95 >= p50 and all positive', async () => {
    const r = await runBench({ iterations: 200 })

    expect(r.writePath.p50).toBeGreaterThan(0)
    expect(r.writePath.p95).toBeGreaterThanOrEqual(r.writePath.p50)
    expect(r.writePath.p99).toBeGreaterThanOrEqual(r.writePath.p95)
  }, 30_000)

  it('write-amplification factor is greater than zero', async () => {
    const r = await runBench({ iterations: 200 })
    expect(r.writeAmplification).toBeGreaterThan(0)
  }, 30_000)
})
