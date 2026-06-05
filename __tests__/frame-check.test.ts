import { applyFrameCheck } from '../src/gates/frame-check.js'
import type { Grant } from '../src/types.js'

const now = Math.floor(Date.now() / 1000)

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 'g1',
    issuer: 'did:key:z6MkTest',
    audience: 'did:key:z6MkAudience',
    grantType: 'read',
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: ['read-summary', 'export-csv'],
    validity: { iat: now - 60, exp: now + 3600 },
    ...overrides,
  }
}

describe('frame-check', () => {
  it('passes when the requested frame is in grant.allowedFrames', () => {
    const grant = makeGrant()
    const result = applyFrameCheck(grant, 'read-summary')
    expect(result.pass).toBe(true)
    expect(result.reasonCode).toBeUndefined()
  })

  it('denies when the requested frame is not in grant.allowedFrames', () => {
    const grant = makeGrant()
    const result = applyFrameCheck(grant, 'bulk-export')
    expect(result.pass).toBe(false)
    expect(result.reasonCode).toBe('frame-not-authorized')
  })

  it('denies when allowedFrames is empty', () => {
    const grant = makeGrant({ allowedFrames: [] })
    const result = applyFrameCheck(grant, 'read-summary')
    expect(result.pass).toBe(false)
    expect(result.reasonCode).toBe('frame-not-authorized')
  })

  it('passes for a second allowed frame', () => {
    const grant = makeGrant()
    const result = applyFrameCheck(grant, 'export-csv')
    expect(result.pass).toBe(true)
  })
})
