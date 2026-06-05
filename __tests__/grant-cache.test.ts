import { generateKeyPair } from '../src/did-key.js'
import { createGrant, signGrant, verifyGrant } from '../src/grant.js'
import { verifyGrantCached, clearGrantCache } from '../src/grant-cache.js'
import { evaluateGateChain } from '../src/gate-engine.js'
import type { Lens, Frame, Grant } from '../src/types.js'

const now = Math.floor(Date.now() / 1000)

const lens: Lens = {
  id: 'lens-test',
  role: 'analyst',
  jurisdiction: 'us',
  entityTypes: ['fact'],
}

const frame: Frame = {
  id: 'cache-frame',
  taskSlug: 'cache-test',
  intent: 'read facts',
  nextStep: 'done',
  requiresApproval: false,
  allowedFrames: [],
}

const fetcher = {
  async fetchFacts(_grant: Grant): Promise<Array<Record<string, unknown>>> {
    return [{ id: 'f1', entity_type: 'fact', content: 'test' }]
  },
}

function makeGrant(overrides?: Partial<Parameters<typeof createGrant>[0]>) {
  return createGrant({
    issuer: 'did:key:z6Mkplaceholder',
    audience: 'did:key:z6Mkaudience',
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: ['cache-frame'],
    validity: { iat: now - 60, exp: now + 3600 },
    ...overrides,
  })
}

beforeEach(() => clearGrantCache())

describe('verifyGrantCached', () => {
  it('returns the same result as verifyGrant for a valid signed grant', async () => {
    const kp = generateKeyPair()
    const grant = await signGrant(makeGrant({ issuer: kp.did }), kp.secretKey)

    const direct = await verifyGrant(grant)
    const cached = await verifyGrantCached(grant)

    expect(cached).toEqual(direct)
    expect(cached.valid).toBe(true)
  })

  it('returns grant-expired matching verifyGrant for an expired grant', async () => {
    const kp = generateKeyPair()
    const grant = await signGrant(
      makeGrant({ issuer: kp.did, validity: { iat: now - 7200, exp: now - 3600 } }),
      kp.secretKey,
    )

    const direct = await verifyGrant(grant)
    const cached = await verifyGrantCached(grant)

    expect(cached).toEqual(direct)
    expect(cached.valid).toBe(false)
    expect(cached.reason).toBe('grant-expired')
  })

  it('returns invalid-signature for a tampered grant (cache miss — different key)', async () => {
    const kp = generateKeyPair()
    const grant = await signGrant(makeGrant({ issuer: kp.did }), kp.secretKey)

    // Prime cache with the original grant
    const original = await verifyGrantCached(grant)
    expect(original.valid).toBe(true)

    // Tamper position 0 of the signature (safe: not the last padding char)
    const parts = grant.signature!.split('.')
    const sig = parts[2]
    const tamperedSig = (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1)
    const tamperedGrant = { ...grant, signature: [parts[0], parts[1], tamperedSig].join('.') }

    // Tampered grant has different cache key → cache miss → fresh verify
    const result = await verifyGrantCached(tamperedGrant)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('invalid-signature')
  })

  it('second call with same grant returns cached object reference (cache hit)', async () => {
    const kp = generateKeyPair()
    const grant = await signGrant(makeGrant({ issuer: kp.did }), kp.secretKey)

    const first = await verifyGrantCached(grant)
    const second = await verifyGrantCached(grant)

    expect(second).toBe(first) // same reference = cache hit, not a new object
  })
})

describe('evaluateGateChain with useGrantCache', () => {
  it('cache on produces byte-identical GateChainResult to cache off for a valid signed grant', async () => {
    const kp = generateKeyPair()
    const grant = await signGrant(makeGrant({ issuer: kp.did }), kp.secretKey)
    const request = { requestId: 'r1', lens, frame }

    const withCache = await evaluateGateChain(grant, request, fetcher, { useGrantCache: true })
    const withoutCache = await evaluateGateChain(grant, request, fetcher)

    expect(withCache).toEqual(withoutCache)
  })
})
