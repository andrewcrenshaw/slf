import { evaluateGateChainWithReceipt } from '../src/gate-engine.js'
import type { SubstrateFetcher } from '../src/gate-engine.js'
import { createSeededFixture, makeFetcher } from '../test-fixtures/seed-lessons.js'
import { createGrant } from '../src/grant.js'
import { generateKeyPair } from '../src/did-key.js'
import { InMemoryReceiptStore } from '../src/receipt-store.js'
import { verifyReceipt } from '../src/receipt.js'
import { verifyChain } from '../src/receipt-chain.js'
import type { Lens, Frame, Grant } from '../src/types.js'

const now = Math.floor(Date.now() / 1000)

const lens: Lens = { id: 'lens-test', role: 'analyst', jurisdiction: 'us', entityTypes: ['fact', 'decision'] }
const frame: Frame = {
  id: 'read-summary',
  taskSlug: 'read-summary',
  intent: 'read facts',
  nextStep: 'review',
  requiresApproval: false,
  allowedFrames: [],
}
const approvalFrame: Frame = { ...frame, id: 'read-sensitive', requiresApproval: true }

function makeGrant(overrides: Record<string, unknown> = {}): Grant {
  return createGrant({
    issuer: 'did:key:z6MkTest',
    audience: 'did:key:z6MkAudience',
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
    allowedFrames: ['read-summary', 'read-sensitive'],
    validity: { iat: now - 60, exp: now + 3600 },
    ...overrides,
  })
}

describe('engine emits a receipt on every terminal outcome', () => {
  it('a granted outcome emits exactly one verifiable signed receipt', async () => {
    const actor = generateKeyPair()
    const store = new InMemoryReceiptStore()
    const grant = makeGrant()
    const fetcher = makeFetcher(createSeededFixture([{ id: 'f1', entity_type: 'fact', content: 'valid' }]))

    const { result, receipt } = await evaluateGateChainWithReceipt(
      grant,
      { requestId: 'r1', lens, frame },
      fetcher,
      { store, actorSecretKey: actor.secretKey },
    )

    expect(result.outcome).toBe('granted')
    expect(receipt).not.toBeNull()
    expect(await store.all()).toHaveLength(1)
    expect(receipt!.outcome).toBe('granted')
    expect(receipt!.grantRef).toBe(grant.id)
    expect(receipt!.gatesEvaluated).toContain('hitl-gate')
    expect(await verifyReceipt(receipt!, actor.did)).toBe(true)
  })

  it('a denied outcome emits exactly one receipt carrying the reason code', async () => {
    const actor = generateKeyPair()
    const store = new InMemoryReceiptStore()
    const grant = makeGrant({ allowedFrames: ['other-frame'] })
    const fetcher = makeFetcher(createSeededFixture([{ id: 'f1', entity_type: 'fact', content: 'v' }]))

    const { result, receipt } = await evaluateGateChainWithReceipt(
      grant,
      { requestId: 'r2', lens, frame: { ...frame, id: 'read-summary' } },
      fetcher,
      { store, actorSecretKey: actor.secretKey },
    )

    expect(result.outcome).toBe('denied')
    expect(await store.all()).toHaveLength(1)
    expect(receipt!.outcome).toBe('denied')
    expect(receipt!.reasonCode).toBe('frame-not-authorized')
    expect(receipt!.redactedFields.length).toBeGreaterThan(0)
    expect(await verifyReceipt(receipt!, actor.did)).toBe(true)
  })

  it('a pending_approval outcome is NOT terminal and emits no receipt', async () => {
    const actor = generateKeyPair()
    const store = new InMemoryReceiptStore()
    const fetcher = makeFetcher(createSeededFixture([{ id: 'f1', entity_type: 'fact', content: 'v' }]))

    const { result, receipt } = await evaluateGateChainWithReceipt(
      makeGrant(),
      { requestId: 'r3', lens, frame: approvalFrame },
      fetcher,
      { store, actorSecretKey: actor.secretKey },
    )

    expect(result.outcome).toBe('pending_approval')
    expect(receipt).toBeNull()
    expect(await store.all()).toHaveLength(0)
  })

  it('an engine error (substrate throws) emits exactly one receipt with outcome error', async () => {
    const actor = generateKeyPair()
    const store = new InMemoryReceiptStore()
    const throwing: SubstrateFetcher = {
      async fetchFacts() {
        throw new Error('substrate unavailable')
      },
    }

    const { result, receipt } = await evaluateGateChainWithReceipt(
      makeGrant(),
      { requestId: 'r4', lens, frame },
      throwing,
      { store, actorSecretKey: actor.secretKey },
    )

    expect(result.outcome).toBe('error')
    expect(await store.all()).toHaveLength(1)
    expect(receipt!.outcome).toBe('error')
    expect(receipt!.reasonCode).toContain('substrate unavailable')
    expect(await verifyReceipt(receipt!, actor.did)).toBe(true)
  })

  it('sequential terminal outcomes hash-chain head-to-tail and verify as a chain', async () => {
    const actor = generateKeyPair()
    const store = new InMemoryReceiptStore()
    const grant = makeGrant()

    await evaluateGateChainWithReceipt(
      grant,
      { requestId: 'a', lens, frame },
      makeFetcher(createSeededFixture([{ id: 'f1', entity_type: 'fact' }])),
      { store, actorSecretKey: actor.secretKey },
    )
    await evaluateGateChainWithReceipt(
      grant,
      { requestId: 'b', lens, frame: { ...frame, id: 'not-allowed' } },
      makeFetcher(createSeededFixture([{ id: 'f2', entity_type: 'fact' }])),
      { store, actorSecretKey: actor.secretKey },
    )

    const all = await store.all()
    expect(all).toHaveLength(2)
    expect(all[0].prevReceiptId).toBeUndefined()
    expect(all[1].prevReceiptId).toBe(all[0].id)
    expect(all[1].chainId).toBe(all[0].id)
    expect(verifyChain(all).valid).toBe(true)
  })
})
