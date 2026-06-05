import type { Grant, ScopeExpression } from './types.js'
import { signJWS, verifyJWS } from './signing.js'

export function createGrant(params: {
  issuer: string
  audience: string
  scopeExpression: ScopeExpression
  allowedFrames: string[]
  validity: { iat: number; exp: number }
}): Grant {
  return {
    id: crypto.randomUUID(),
    grantType: 'read',
    ...params,
  }
}

export async function signGrant(grant: Grant, secretKey: Uint8Array): Promise<Grant> {
  const { signature: _sig, ...payload } = grant
  const jws = await signJWS(payload as Record<string, unknown>, secretKey)
  return { ...grant, signature: jws }
}

export async function verifyGrant(
  grant: Grant,
): Promise<{ valid: boolean; reason?: string }> {
  const now = Math.floor(Date.now() / 1000)

  if (grant.validity.exp < now) {
    return { valid: false, reason: 'grant-expired' }
  }

  if (!grant.signature) {
    return { valid: false, reason: 'no-signature' }
  }

  const valid = await verifyJWS(grant.signature, grant.issuer)
  return valid ? { valid: true } : { valid: false, reason: 'invalid-signature' }
}
