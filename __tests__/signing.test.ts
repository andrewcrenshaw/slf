import { generateKeyPair } from '../src/did-key.js'
import { signJWS, verifyJWS } from '../src/signing.js'

describe('signing', () => {
  it('sign then verify returns true', async () => {
    const kp = generateKeyPair()
    const payload = { sub: 'alice', action: 'read', ts: 1000 }
    const jws = await signJWS(payload, kp.secretKey)
    const valid = await verifyJWS(jws, kp.did)
    expect(valid).toBe(true)
  })

  it('JWS verification rejects a one-byte-tampered signature', async () => {
    const kp = generateKeyPair()
    const payload = { sub: 'alice', action: 'read' }
    const jws = await signJWS(payload, kp.secretKey)

    const parts = jws.split('.')
    const sig = parts[2]
    const tampered = (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1)
    const tamperedJws = [parts[0], parts[1], tampered].join('.')

    const valid = await verifyJWS(tamperedJws, kp.did)
    expect(valid).toBe(false)
  })

  it('verification fails for a different DID', async () => {
    const kp1 = generateKeyPair()
    const kp2 = generateKeyPair()
    const jws = await signJWS({ data: 'test' }, kp1.secretKey)
    const valid = await verifyJWS(jws, kp2.did)
    expect(valid).toBe(false)
  })

  it('RFC-8785: objects with same content but different key order produce identical signing input', async () => {
    const kp = generateKeyPair()
    const a = { z: 1, a: 2, m: 3 }
    const b = { m: 3, z: 1, a: 2 }
    const jwsA = await signJWS(a, kp.secretKey)
    const jwsB = await signJWS(b, kp.secretKey)
    const payloadA = jwsA.split('.')[1]
    const payloadB = jwsB.split('.')[1]
    expect(payloadA).toBe(payloadB)
  })
})
