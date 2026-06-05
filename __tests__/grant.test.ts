import { generateKeyPair } from '../src/did-key.js'
import { createGrant, signGrant, verifyGrant } from '../src/grant.js'

const now = Math.floor(Date.now() / 1000)

function makeGrant(overrides?: Partial<Parameters<typeof createGrant>[0]>) {
  return createGrant({
    issuer: 'did:key:z6Mkplaceholder',
    audience: 'did:key:z6Mkaudience',
    scopeExpression: { op: 'EQUALS', field: 'type', value: 'lesson' },
    allowedFrames: ['read-summary'],
    validity: { iat: now - 60, exp: now + 3600 },
    ...overrides,
  })
}

describe('grant', () => {
  it('createGrant emits the correct shape', () => {
    const g = makeGrant()
    expect(typeof g.id).toBe('string')
    expect(g.grantType).toBe('read')
    expect(g.allowedFrames).toEqual(['read-summary'])
    expect(g.validity.exp).toBeGreaterThan(now)
  })

  it('signGrant + verifyGrant returns valid: true', async () => {
    const kp = generateKeyPair()
    const g = makeGrant({ issuer: kp.did })
    const signed = await signGrant(g, kp.secretKey)
    const result = await verifyGrant(signed)
    expect(result.valid).toBe(true)
  })

  it('Grant verification fails on an expired validity window', async () => {
    const kp = generateKeyPair()
    const g = makeGrant({
      issuer: kp.did,
      validity: { iat: now - 7200, exp: now - 3600 },
    })
    const signed = await signGrant(g, kp.secretKey)
    const result = await verifyGrant(signed)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('grant-expired')
  })

  it('verifyGrant fails when signature is absent', async () => {
    const g = makeGrant()
    const result = await verifyGrant(g)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('no-signature')
  })

  it('tampered signature returns invalid', async () => {
    const kp = generateKeyPair()
    const g = makeGrant({ issuer: kp.did })
    const signed = await signGrant(g, kp.secretKey)
    const parts = signed.signature!.split('.')
    const sig = parts[2]
    // Flip the FIRST signature char (always significant). The last base64url char
    // of a 64-byte Ed25519 signature carries only 2 significant bits (the low 4
    // are zero padding), so flipping it mutates padding alone ~25% of the time and
    // decodes back to the same, still-valid signature - a flaky tamper.
    const tampered = (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1)
    const tamperedGrant = {
      ...signed,
      signature: [parts[0], parts[1], tampered].join('.'),
    }
    const result = await verifyGrant(tamperedGrant)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('invalid-signature')
  })
})
