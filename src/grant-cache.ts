import { verifyGrant } from './grant.js'
import type { Grant } from './types.js'

const _cache = new Map<string, { valid: boolean; reason?: string }>()

function cacheKey(grant: Grant): string {
  return `${grant.id}|${grant.signature ?? ''}`
}

export async function verifyGrantCached(
  grant: Grant,
): Promise<{ valid: boolean; reason?: string }> {
  const key = cacheKey(grant)
  const hit = _cache.get(key)
  if (hit !== undefined) return hit
  const result = await verifyGrant(grant)
  _cache.set(key, result)
  return result
}

export function clearGrantCache(): void {
  _cache.clear()
}
