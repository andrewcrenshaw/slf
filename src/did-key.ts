import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import type { KeyPair, OkpPublicJwk } from './types.js'

// Enable synchronous operations for @noble/ed25519 v1.x
ed.utils.sha512Sync = (...m: Uint8Array[]) => sha512(Buffer.concat(m))

// Ed25519 multicodec varint prefix: 0xed (237) encoded as LEB128 = [0xED, 0x01]
const MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01])

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0
  for (const byte of bytes) {
    if (byte !== 0) break
    leadingZeros++
  }
  const hex = Buffer.from(bytes).toString('hex')
  let num = hex ? BigInt('0x' + hex) : 0n
  let result = ''
  while (num > 0n) {
    const mod = Number(num % 58n)
    num = num / 58n
    result = BASE58_ALPHABET[mod] + result
  }
  return '1'.repeat(leadingZeros) + result
}

function decodeBase58(str: string): Uint8Array {
  let num = 0n
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char)
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`)
    num = num * 58n + BigInt(idx)
  }
  let leadingZeros = 0
  for (const char of str) {
    if (char !== '1') break
    leadingZeros++
  }
  if (num === 0n) return new Uint8Array(leadingZeros)
  const hex = num.toString(16)
  const hexPadded = hex.length % 2 ? '0' + hex : hex
  const decoded = Buffer.from(hexPadded, 'hex')
  const result = new Uint8Array(leadingZeros + decoded.length)
  result.set(decoded, leadingZeros)
  return result
}

function toPublicJwk(publicKey: Uint8Array): OkpPublicJwk {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(publicKey).toString('base64url'),
  }
}

export function encodeDid(publicKey: Uint8Array): string {
  const multicodec = new Uint8Array(MULTICODEC_PREFIX.length + publicKey.length)
  multicodec.set(MULTICODEC_PREFIX)
  multicodec.set(publicKey, MULTICODEC_PREFIX.length)
  return `did:key:z${encodeBase58(multicodec)}`
}

export function decodeDid(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error(`Invalid did:key format: ${did}`)
  }
  const encoded = did.slice('did:key:z'.length)
  const bytes = decodeBase58(encoded)
  return bytes.slice(MULTICODEC_PREFIX.length)
}

export function generateKeyPair(): KeyPair {
  const secretKey = ed.utils.randomPrivateKey()
  const publicKey = ed.sync.getPublicKey(secretKey)
  const did = encodeDid(publicKey)
  const publicJwk = toPublicJwk(publicKey)
  return { did, publicJwk, secretKey }
}
