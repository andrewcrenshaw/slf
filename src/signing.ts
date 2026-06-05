import { CompactSign, compactVerify, importJWK } from 'jose'
import { sync as edSync, utils as edUtils } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { decodeDid } from './did-key.js'

// Ensure sha512Sync is set (idempotent; did-key may have already set it)
if (!edUtils.sha512Sync) {
  edUtils.sha512Sync = (...m: Uint8Array[]) => sha512(Buffer.concat(m))
}

/**
 * RFC-8785 JSON Canonicalization Scheme — recursive key-sorted serialization.
 * Handles the payload types we use in grants (objects, strings, numbers, booleans, arrays).
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const pairs = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    return '{' + pairs.join(',') + '}'
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`)
}

async function toSigningKey(secretKey: Uint8Array) {
  const publicKey = edSync.getPublicKey(secretKey)
  const jwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(publicKey).toString('base64url'),
    d: Buffer.from(secretKey).toString('base64url'),
  }
  return importJWK(jwk, 'EdDSA')
}

async function toVerifyKey(did: string) {
  const publicKey = decodeDid(did)
  const jwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(publicKey).toString('base64url'),
  }
  return importJWK(jwk, 'EdDSA')
}

export async function signJWS(
  payload: Record<string, unknown>,
  secretKey: Uint8Array,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload))
  const key = await toSigningKey(secretKey)
  return new CompactSign(bytes).setProtectedHeader({ alg: 'EdDSA' }).sign(key)
}

export async function verifyJWS(jws: string, did: string): Promise<boolean> {
  try {
    const key = await toVerifyKey(did)
    await compactVerify(jws, key)
    return true
  } catch {
    return false
  }
}
