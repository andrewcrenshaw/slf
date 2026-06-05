# SLF-core Benchmark Results

**Measured on:** Apple M4 (Mac mini 2025, macOS 15.5)  
**Date:** 2026-06-02  
**Commit:** see `git log -1 --format="%H" packages/slf-core/`  
**Methodology:** 10,000 iterations warm-cache read path; 500 iterations cold-cache; 2,000 iterations write path. JIT warm-up: 50 calls before measurement. Process-level hrtime nanosecond resolution. Single-threaded (1 core).

---

## Gate engine latency

| path  | cache | p50      | p95      | p99      | ops/s   |
|-------|-------|----------|----------|----------|---------|
| read  | warm  | 0.8 μs   | 8.7 μs   | 11.2 μs  | 531,818 |
| read  | cold  | 70.5 μs  | 90.1 μs  | 135.6 μs | 13,631  |
| write | warm  | 159.9 μs | 202.2 μs | 318.4 μs | 5,957   |

**warm** = grant signature already in cache (Map lookup, no Ed25519)  
**cold** = cache cleared before each call (fresh Ed25519 verify each iteration)  
**write** = `evaluateGateChainWithReceipt` with Ed25519 receipt signing

---

## Write-amplification factor

| metric              | value     | formula                              |
|---------------------|-----------|--------------------------------------|
| Read ops/s (warm)   | 531,818   |                                      |
| Write ops/s (warm)  | 5,957     |                                      |
| Time ratio          | **89.3×** | read ops/s ÷ write ops/s             |

The factor is dominated by the Ed25519 sign in the write path (~146 μs) vs a Map lookup in the warm-cache read path (~0.8 μs). In production, batched or async receipt emission would reduce this ratio substantially.

---

## Crypto microbench (1,000 iterations)

| operation      | p50      | p95      | p99      | note                         |
|----------------|----------|----------|----------|------------------------------|
| Ed25519 sign   | 146.1 μs | 171.6 μs | 245.1 μs | `signJWS` via jose + @noble  |
| Ed25519 verify | 66.0 μs  | 79.7 μs  | 94.9 μs  | `verifyJWS` via jose + @noble |
| SHA-256        | 0.6 μs   | 0.9 μs   | 1.9 μs   | Node built-in `createHash`   |

Verify (66 μs) is ~2.2× faster than sign (146 μs), consistent with Ed25519 design.
SHA-256 is sub-microsecond — negligible in the gate path.

---

## Overhead vs retrieval baseline

| retrieval backend | p95 latency | SLF warm-cache gate p95 | overhead %  |
|-------------------|-------------|-------------------------|-------------|
| pgvector / HNSW   | 5–20 ms     | 8.7 μs                  | **0.1%**    |

SLF gate evaluation with a warm cache adds ~0.1% to a typical pgvector retrieval. Cold-cache adds ~90 μs per grant (≈1.2% of the retrieval midpoint), amortized quickly across repeated reads with the same grant.

---

## Reproducing

```bash
cd packages/slf-core
npm run bench              # 10,000 iterations (default)
npm run bench 50000        # custom iteration count
```

Numbers are deterministic in shape (p99 ≥ p95 ≥ p50) but will vary by machine.
