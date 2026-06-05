import {
  generateSubjectKey,
  sealContent,
  openContent,
  hmacCommit,
  shred,
  buildErasureReceipt,
} from '../src/erasure.js'
import { generateKeyPair } from '../src/did-key.js'
import { verifyReceipt } from '../src/receipt.js'

describe('erasure module', () => {
  describe('sealContent / openContent', () => {
    it('round-trips plaintext through XChaCha20-Poly1305', () => {
      const key = generateSubjectKey()
      const plaintext = new TextEncoder().encode('hello world')
      const sealed = sealContent(plaintext, key)
      const opened = openContent(sealed, key)
      expect(Buffer.from(opened)).toEqual(Buffer.from(plaintext))
    })

    it('uses a fresh nonce each seal so identical plaintext produces different ciphertext', () => {
      const key = generateSubjectKey()
      const plaintext = new TextEncoder().encode('same content')
      const s1 = sealContent(plaintext, key)
      const s2 = sealContent(plaintext, key)
      expect(Buffer.from(s1.nonce)).not.toEqual(Buffer.from(s2.nonce))
    })

    it('throws on openContent after shred (zeroed key fails MAC verification)', () => {
      const key = generateSubjectKey()
      const plaintext = new TextEncoder().encode('sensitive datum')
      const sealed = sealContent(plaintext, key)
      shred(key)
      expect(() => openContent(sealed, key)).toThrow()
    })
  })

  describe('hmacCommit', () => {
    it('produces a stable commitment for the same key+content', () => {
      const key = generateSubjectKey()
      const content = new TextEncoder().encode('stable content')
      const c1 = hmacCommit(content, key)
      const c2 = hmacCommit(content, key)
      expect(Buffer.from(c1)).toEqual(Buffer.from(c2))
    })

    it('commitment changes when the key changes', () => {
      const key1 = generateSubjectKey()
      const key2 = generateSubjectKey()
      const content = new TextEncoder().encode('same content')
      expect(Buffer.from(hmacCommit(content, key1))).not.toEqual(Buffer.from(hmacCommit(content, key2)))
    })

    it('two subjects with different keys produce different commitments for identical content', () => {
      const keyA = generateSubjectKey()
      const keyB = generateSubjectKey()
      const content = new TextEncoder().encode('identical content')
      expect(Buffer.from(hmacCommit(content, keyA))).not.toEqual(Buffer.from(hmacCommit(content, keyB)))
    })
  })

  describe('shred', () => {
    it('zeroes the key buffer in place', () => {
      const key = generateSubjectKey()
      shred(key)
      expect(key.every((b) => b === 0)).toBe(true)
    })

    it('post-shred key enumeration finds only zero bytes (no recovery path)', () => {
      const key = generateSubjectKey()
      shred(key)
      expect([...key].filter((b) => b !== 0)).toHaveLength(0)
    })
  })

  describe('buildErasureReceipt', () => {
    it('emits a signed payload-free receipt with reasonCode erased', async () => {
      const actor = generateKeyPair()
      const receipt = await buildErasureReceipt('erased:alice:test', actor.secretKey, {
        timestamp: 1_780_000_000_000,
      })
      expect(receipt.reasonCode).toBe('erased')
      expect(receipt.outcome).toBe('denied')
      expect(receipt.disclosedFields).toEqual([])
      expect(receipt.redactedFields).toEqual([])
    })

    it('erasure receipt signature verifies against the actor DID', async () => {
      const actor = generateKeyPair()
      const receipt = await buildErasureReceipt('erased:bob:test', actor.secretKey, {
        timestamp: 1_780_000_000_000,
      })
      expect(await verifyReceipt(receipt, actor.did)).toBe(true)
    })

    it('sealed content is unrecoverable and erasure receipt verifies (full shred round-trip)', async () => {
      const actor = generateKeyPair()
      const key = generateSubjectKey()
      const plaintext = new TextEncoder().encode('sensitive')
      const sealed = sealContent(plaintext, key)

      const opened = openContent(sealed, key)
      expect(Buffer.from(opened)).toEqual(Buffer.from(plaintext))

      shred(key)
      expect(() => openContent(sealed, key)).toThrow()

      const receipt = await buildErasureReceipt('erased:carol:test', actor.secretKey, {
        timestamp: 1_780_000_000_000,
      })
      expect(await verifyReceipt(receipt, actor.did)).toBe(true)
    })
  })
})
