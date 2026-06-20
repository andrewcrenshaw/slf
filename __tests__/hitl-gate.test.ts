import { applyHitlGate, signApprovalToken } from '../src/gates/hitl-gate.js'
import { generateKeyPair } from '../src/did-key.js'

const sampleFacts = [
  { id: '1', entity_type: 'fact', content: 'hello' },
  { id: '2', entity_type: 'fact', content: 'world' },
]

const nowSec = Math.floor(Date.now() / 1000)

describe('hitl-gate', () => {
  it('passes through when requiresApproval is false', () => {
    const result = applyHitlGate(false, 'req-1', sampleFacts)
    expect(result.outcome).toBe('pass')
    expect(result.disclosurePreview).toBeUndefined()
  })

  it('returns pending_approval when requiresApproval is true and no token provided', () => {
    const result = applyHitlGate(true, 'req-1', sampleFacts)
    expect(result.outcome).toBe('pending_approval')
    expect(typeof result.disclosurePreview).toBe('string')
    expect(result.disclosurePreview).toContain('req-1')
  })

  it('resumes as pass on a signed approval token bound to the request (PCC-3119)', () => {
    const approver = generateKeyPair()
    const token = signApprovalToken(
      { requestId: 'req-1', approver: approver.did, iat: nowSec - 10, exp: nowSec + 600 },
      approver.secretKey,
    )
    const result = applyHitlGate(true, 'req-1', sampleFacts, token)
    expect(result.outcome).toBe('pass')
  })

  it('rejects the bare approve: bypass string (PCC-3119)', () => {
    const result = applyHitlGate(true, 'req-1', sampleFacts, 'approve:')
    expect(result.outcome).not.toBe('pass')
    expect(result.outcome).toBe('pending_approval')
  })

  it('rejects an unsigned approve:<id> token (PCC-3119)', () => {
    const result = applyHitlGate(true, 'req-1', sampleFacts, 'approve:req-1')
    expect(result.outcome).not.toBe('pass')
  })

  it('rejects a signed token bound to a different requestId (PCC-3119)', () => {
    const approver = generateKeyPair()
    const token = signApprovalToken(
      { requestId: 'other', approver: approver.did, iat: nowSec - 10, exp: nowSec + 600 },
      approver.secretKey,
    )
    const result = applyHitlGate(true, 'req-1', sampleFacts, token)
    expect(result.outcome).not.toBe('pass')
    expect(result.reasonCode).toBe('approval-request-mismatch')
  })

  it('rejects an expired signed token (PCC-3119)', () => {
    const approver = generateKeyPair()
    const token = signApprovalToken(
      { requestId: 'req-1', approver: approver.did, iat: nowSec - 7200, exp: nowSec - 3600 },
      approver.secretKey,
    )
    const result = applyHitlGate(true, 'req-1', sampleFacts, token)
    expect(result.outcome).not.toBe('pass')
    expect(result.reasonCode).toBe('approval-expired')
  })

  it('rejects a token whose signature does not match the claimed approver (PCC-3119)', () => {
    const approver = generateKeyPair()
    const intruder = generateKeyPair()
    const token = signApprovalToken(
      { requestId: 'req-1', approver: approver.did, iat: nowSec - 10, exp: nowSec + 600 },
      intruder.secretKey,
    )
    const result = applyHitlGate(true, 'req-1', sampleFacts, token)
    expect(result.outcome).not.toBe('pass')
    expect(result.reasonCode).toBe('approval-signature-invalid')
  })

  it('enforces a trusted-approver allowlist when provided (PCC-3119)', () => {
    const approver = generateKeyPair()
    const intruder = generateKeyPair()
    const intruderToken = signApprovalToken(
      { requestId: 'req-1', approver: intruder.did, iat: nowSec - 10, exp: nowSec + 600 },
      intruder.secretKey,
    )
    const rejected = applyHitlGate(true, 'req-1', sampleFacts, intruderToken, [approver.did])
    expect(rejected.outcome).not.toBe('pass')
    expect(rejected.reasonCode).toBe('approver-not-trusted')

    const trustedToken = signApprovalToken(
      { requestId: 'req-1', approver: approver.did, iat: nowSec - 10, exp: nowSec + 600 },
      approver.secretKey,
    )
    expect(applyHitlGate(true, 'req-1', sampleFacts, trustedToken, [approver.did]).outcome).toBe('pass')
  })

  it('denies when a deny: token is provided', () => {
    const result = applyHitlGate(true, 'req-1', sampleFacts, 'deny:req-1')
    expect(result.outcome).toBe('denied')
    expect(result.reasonCode).toBe('approval-denied')
  })

  it('returns pending_approval for an unrecognized token format', () => {
    const result = applyHitlGate(true, 'req-1', sampleFacts, 'invalid-token')
    expect(result.outcome).toBe('pending_approval')
  })
})
