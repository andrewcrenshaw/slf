import { applyHitlGate } from '../src/gates/hitl-gate.js'

const sampleFacts = [
  { id: '1', entity_type: 'fact', content: 'hello' },
  { id: '2', entity_type: 'fact', content: 'world' },
]

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

  it('resumes as pass when an approve: token is provided', () => {
    const result = applyHitlGate(true, 'req-1', sampleFacts, 'approve:req-1')
    expect(result.outcome).toBe('pass')
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
