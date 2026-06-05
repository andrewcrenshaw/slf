import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { buildReceipt, signReceipt, type Receipt } from './receipt.js'
import type { GateChainResult } from './gate-engine.js'

export type SubjectKey = Uint8Array

export interface SealedContent {
  nonce: Uint8Array
  ciphertext: Uint8Array
}

export function generateSubjectKey(): SubjectKey {
  return randomBytes(32)
}

export function sealContent(plaintext: Uint8Array, key: SubjectKey): SealedContent {
  const nonce = randomBytes(24)
  const cipher = xchacha20poly1305(key, nonce)
  const ciphertext = cipher.encrypt(plaintext)
  return { nonce, ciphertext }
}

export function openContent(sealed: SealedContent, key: SubjectKey): Uint8Array {
  const cipher = xchacha20poly1305(key, sealed.nonce)
  return cipher.decrypt(sealed.ciphertext)
}

export function hmacCommit(content: Uint8Array, key: SubjectKey): Uint8Array {
  return hmac(sha256, key, content)
}

export function shred(key: SubjectKey): void {
  key.fill(0)
}

export interface ErasureReceiptOptions {
  timestamp: number
  prevReceiptId?: string
  chainId?: string
}

export async function buildErasureReceipt(
  grantRef: string,
  actorSecretKey: Uint8Array,
  options: ErasureReceiptOptions,
): Promise<Receipt> {
  const erasureResult: GateChainResult = {
    outcome: 'denied',
    disclosed: [],
    redacted: [],
    gatesEvaluated: [],
    reasonCode: 'erased',
  }
  const unsigned = buildReceipt(erasureResult, { id: grantRef }, {
    timestamp: options.timestamp,
    prevReceiptId: options.prevReceiptId,
    chainId: options.chainId,
  })
  return signReceipt(unsigned, actorSecretKey)
}
