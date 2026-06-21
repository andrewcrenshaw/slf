import { verifyGrant } from './grant.js'
import type { Grant } from './types.js'

// Caches only the time-invariant half of a grant verdict: the signature-validity
// result (valid / no-signature / invalid-signature), keyed by id|signature. Grant
// expiry is time-variant, so it is re-checked on every read — a grant verified (and
// cached) while valid must stop being served as valid the moment it expires. Folding
// expiry into the cache key would not fix this: exp is a fixed field on the grant, so
// the key is identical before and after expiry (TOCTOU; PCC-3120).
const _cache = new Map<string, { valid: boolean; reason?: string }>()

function cacheKey(grant: Grant): string {
  return `${grant.id}|${grant.signature ?? ''}`
}

export async function verifyGrantCached(
  grant: Grant,
): Promise<{ valid: boolean; reason?: string }> {
  // Re-check expiry on every read. This is the time-variant part of the verdict and
  // must never be served from cache, or a grant verified before its expiry would
  // keep returning valid afterwards.
  const now = Math.floor(Date.now() / 1000)
  if (grant.validity.exp < now) {
    return { valid: false, reason: 'grant-expired' }
  }

  const key = cacheKey(grant)
  const hit = _cache.get(key)
  if (hit !== undefined) return hit

  const result = await verifyGrant(grant)
  // Cache only the signature-validity verdict. The grant is non-expired here, so a
  // 'grant-expired' result can only come from a clock tick racing verifyGrant's own
  // check; never cache it, or that stale expiry verdict would be replayed forever.
  if (result.reason !== 'grant-expired') {
    _cache.set(key, result)
  }
  return result
}

export function clearGrantCache(): void {
  _cache.clear()
}
