import { applySubstrateGate } from '../src/gates/substrate-gate.js'
import type { Grant } from '../src/types.js'

const now = Math.floor(Date.now() / 1000)

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 'g1',
    issuer: 'did:key:z6MkTest',
    audience: 'did:key:z6MkAudience',
    grantType: 'read',
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: ['read-summary'],
    validity: { iat: now - 60, exp: now + 3600 },
    ...overrides,
  }
}

describe('substrate-gate', () => {
  it('passes a valid fact within scope', () => {
    const grant = makeGrant()
    const fact = { id: '1', entity_type: 'fact', content: 'hello', valid_at: null, invalid_at: null }
    const result = applySubstrateGate(grant, fact)
    expect(result.pass).toBe(true)
  })

  it('excludes a fact whose invalid_at is in the past', () => {
    const grant = makeGrant()
    const fact = { id: '2', entity_type: 'fact', content: 'expired', valid_at: null, invalid_at: now - 100 }
    const result = applySubstrateGate(grant, fact)
    expect(result.pass).toBe(false)
    expect(result.reasonCode).toBe('fact-expired')
  })

  it('excludes a fact whose valid_at is in the future', () => {
    const grant = makeGrant()
    const fact = { id: '3', entity_type: 'fact', content: 'future', valid_at: now + 9999, invalid_at: null }
    const result = applySubstrateGate(grant, fact)
    expect(result.pass).toBe(false)
    expect(result.reasonCode).toBe('fact-not-yet-valid')
  })

  it('excludes a fact whose scope does not match the grant scope expression', () => {
    const grant = makeGrant()
    const fact = { id: '4', entity_type: 'claim', content: 'claim text', valid_at: null, invalid_at: null }
    const result = applySubstrateGate(grant, fact)
    expect(result.pass).toBe(false)
    expect(result.reasonCode).toBe('scope-mismatch')
  })

  it('redacts a health-data-tagged fact when grant lacks the gates scope', () => {
    const grant = makeGrant()
    const fact = { id: '5', entity_type: 'fact', content: 'sensitive', gates: ['health-data'], valid_at: null, invalid_at: null }
    const result = applySubstrateGate(grant, fact)
    expect(result.pass).toBe(false)
    expect(result.reasonCode).toBe('gate-tag-restricted')
  })

  it('allows a health-data-tagged fact when grant explicitly covers health-data via gates field', () => {
    const grant = makeGrant({
      scopeExpression: {
        op: 'AND',
        args: [
          { op: 'EQUALS', field: 'entity_type', value: 'fact' },
          { op: 'WITHIN', field: 'gates', set: ['health-data'] },
        ],
      },
    })
    const fact = { id: '6', entity_type: 'fact', content: 'health info', gates: 'health-data', valid_at: null, invalid_at: null }
    const result = applySubstrateGate(grant, fact)
    expect(result.pass).toBe(true)
  })
})
