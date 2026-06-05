import { generateKeyPair, encodeDid, decodeDid } from '../src/did-key.js'

describe('did-key', () => {
  it('keypair round-trips: encode → decode yields original public key', () => {
    const kp = generateKeyPair()
    const decoded = decodeDid(kp.did)
    const pubBytes = new Uint8Array(Buffer.from(kp.publicJwk.x, 'base64url'))
    expect(decoded).toEqual(pubBytes)
  })

  it('DID string is prefixed did:key:z6Mk (Ed25519)', () => {
    const kp = generateKeyPair()
    expect(kp.did).toMatch(/^did:key:z6Mk/)
  })

  it('encodeDid / decodeDid inverse', () => {
    const kp = generateKeyPair()
    const pubBytes = new Uint8Array(Buffer.from(kp.publicJwk.x, 'base64url'))
    const did = encodeDid(pubBytes)
    const roundTripped = decodeDid(did)
    expect(roundTripped).toEqual(pubBytes)
  })

  it('decodeDid throws on invalid format', () => {
    expect(() => decodeDid('not:a:did')).toThrow('Invalid did:key format')
  })

  it('publicJwk has OKP/Ed25519 shape', () => {
    const kp = generateKeyPair()
    expect(kp.publicJwk.kty).toBe('OKP')
    expect(kp.publicJwk.crv).toBe('Ed25519')
    expect(typeof kp.publicJwk.x).toBe('string')
  })
})
