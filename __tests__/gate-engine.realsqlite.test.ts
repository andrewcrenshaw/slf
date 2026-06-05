import { evaluateGateChain } from '../src/gate-engine.js'
import { createSeededFixture, makeFetcher } from '../test-fixtures/seed-lessons.js'
import { createGrant } from '../src/grant.js'
import type { Lens, Frame } from '../src/types.js'

const now = Math.floor(Date.now() / 1000)

const lens: Lens = {
  id: 'lens-test',
  role: 'analyst',
  jurisdiction: 'us',
  entityTypes: ['fact', 'decision'],
}

const frame: Frame = {
  id: 'read-summary',
  taskSlug: 'read-summary',
  intent: 'read facts',
  nextStep: 'review',
  requiresApproval: false,
  allowedFrames: [],
}

const approvalFrame: Frame = {
  ...frame,
  id: 'read-sensitive',
  requiresApproval: true,
}

function makeGrant(overrides = {}) {
  return createGrant({
    issuer: 'did:key:z6MkTest',
    audience: 'did:key:z6MkAudience',
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: ['read-summary', 'read-sensitive'],
    validity: { iat: now - 60, exp: now + 3600 },
    ...overrides,
  })
}

describe('gate-engine (real SQLite)', () => {
  it('grants only rows matching scope from a seeded SQLite fixture', async () => {
    const db = createSeededFixture([
      { id: 'f1', entity_type: 'fact', content: 'valid fact', domain: 'general' },
      { id: 'f2', entity_type: 'claim', content: 'a claim', domain: 'general' },
      { id: 'f3', entity_type: 'fact', content: 'expired fact', invalid_at: now - 100 },
    ])
    const fetcher = makeFetcher(db)
    const grant = makeGrant()
    const result = await evaluateGateChain(grant, { requestId: 'r1', lens, frame }, fetcher)

    expect(result.outcome).toBe('granted')
    // Only f1 passes: f2 is wrong entity_type (scope-mismatch), f3 is expired
    expect(result.disclosed.length).toBe(1)
    expect(result.disclosed[0].id).toBe('f1')
    expect(result.gatesEvaluated).toContain('substrate-gate')
    expect(result.gatesEvaluated).toContain('lens-projection')
    expect(result.gatesEvaluated).toContain('frame-check')
    expect(result.gatesEvaluated).toContain('hitl-gate')
  })

  it('denies when the requested frame is not in grant.allowedFrames', async () => {
    const db = createSeededFixture([
      { id: 'f1', entity_type: 'fact', content: 'valid fact' },
    ])
    const fetcher = makeFetcher(db)
    const grant = makeGrant({ allowedFrames: ['other-frame'] })
    const unauthorizedFrame: Frame = { ...frame, id: 'read-summary' }
    const result = await evaluateGateChain(grant, { requestId: 'r2', lens, frame: unauthorizedFrame }, fetcher)

    expect(result.outcome).toBe('denied')
    expect(result.reasonCode).toBe('frame-not-authorized')
    expect(result.disclosed.length).toBe(0)
  })

  it('gates evaluate in order 1->2->3->4 and each short-circuits with a reason_code', async () => {
    const db = createSeededFixture([
      { id: 'e1', entity_type: 'fact', content: 'expired', invalid_at: now - 1 },
      { id: 'e2', entity_type: 'claim', content: 'filtered by lens' },
    ])
    const fetcher = makeFetcher(db)
    const grant = makeGrant()
    const result = await evaluateGateChain(grant, { requestId: 'r3', lens, frame }, fetcher)

    expect(result.outcome).toBe('granted')
    expect(result.disclosed.length).toBe(0)
    // e1 redacted by substrate-gate (expired), e2 redacted by substrate-gate (scope-mismatch)
    const reasonCodes = result.redacted.map(r => r.reasonCode)
    expect(reasonCodes).toContain('fact-expired')
    expect(reasonCodes).toContain('scope-mismatch')
  })

  it('returns pending_approval when frame requires HITL and no token is provided', async () => {
    const db = createSeededFixture([
      { id: 'f1', entity_type: 'fact', content: 'sensitive fact' },
    ])
    const fetcher = makeFetcher(db)
    const grant = makeGrant()
    const result = await evaluateGateChain(grant, { requestId: 'r4', lens, frame: approvalFrame }, fetcher)

    expect(result.outcome).toBe('pending_approval')
    expect(typeof result.disclosurePreview).toBe('string')
    expect(result.disclosed.length).toBe(0)
  })

  it('grants disclosure after a valid approval token is provided', async () => {
    const db = createSeededFixture([
      { id: 'f1', entity_type: 'fact', content: 'approved fact' },
    ])
    const fetcher = makeFetcher(db)
    const grant = makeGrant()
    const result = await evaluateGateChain(
      grant,
      { requestId: 'r5', lens, frame: approvalFrame, approvalToken: 'approve:r5' },
      fetcher,
    )

    expect(result.outcome).toBe('granted')
    expect(result.disclosed.length).toBe(1)
  })
})
