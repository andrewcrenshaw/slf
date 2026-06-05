import * as fc from 'fast-check'
import { evaluateGateChain } from '../src/gate-engine.js'
import { createGrant } from '../src/grant.js'
import type { Grant, Lens, Frame } from '../src/types.js'
import {
  arbFacts,
  arbGrant,
  arbLens,
  makeRequestFrame,
  narrowByScope,
  narrowByLens,
  narrowByFrame,
  widenByUnion,
} from '../src/conformance/narrowing-gen.js'

function isSubsetByFactId(
  narrowDisclosed: Array<Record<string, unknown>>,
  wideDisclosed: Array<Record<string, unknown>>,
): boolean {
  const wideIds = new Set(wideDisclosed.map(f => f.id as string))
  return narrowDisclosed.every(f => wideIds.has(f.id as string))
}

function makeFetcher(facts: Array<Record<string, unknown>>) {
  return {
    async fetchFacts(_grant: Grant): Promise<Array<Record<string, unknown>>> {
      return facts
    },
  }
}

describe('monotonic-narrowing property suite', () => {
  it('arbitraries smoke: 100 random runs do not throw', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, arbGrant, arbLens, async (facts, grant, lens) => {
        const frame = makeRequestFrame(grant)
        const fetcher = makeFetcher(facts)
        const result = await evaluateGateChain(grant, { requestId: 'r-smoke', lens, frame }, fetcher)
        return ['granted', 'denied', 'partial', 'pending_approval', 'error'].includes(result.outcome)
      }),
      { numRuns: 100 },
    )
  }, 30000)

  it('scope narrowing: AND-tightening scopeExpression never widens disclosed', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, arbGrant, arbLens, async (facts, grant, lens) => {
        const frame = makeRequestFrame(grant)
        const fetcher = makeFetcher(facts)
        const wide = await evaluateGateChain(grant, { requestId: 'r-wide', lens, frame }, fetcher)
        const narrow = await evaluateGateChain(narrowByScope(grant), { requestId: 'r-narrow', lens, frame }, fetcher)
        return isSubsetByFactId(narrow.disclosed, wide.disclosed)
      }),
      { numRuns: 1000 },
    )
  }, 60000)

  it('lens narrowing: dropping an entityType never widens disclosed', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, arbGrant, arbLens, async (facts, grant, lens) => {
        const frame = makeRequestFrame(grant)
        const fetcher = makeFetcher(facts)
        const wide = await evaluateGateChain(grant, { requestId: 'r-wide', lens, frame }, fetcher)
        const narrow = await evaluateGateChain(grant, { requestId: 'r-narrow', lens: narrowByLens(lens), frame }, fetcher)
        return isSubsetByFactId(narrow.disclosed, wide.disclosed)
      }),
      { numRuns: 1000 },
    )
  }, 60000)

  it('frame narrowing: dropping an allowedFrame never widens disclosed', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, arbGrant, arbLens, async (facts, grant, lens) => {
        const frame = makeRequestFrame(grant)
        const fetcher = makeFetcher(facts)
        const wide = await evaluateGateChain(grant, { requestId: 'r-wide', lens, frame }, fetcher)
        const narrow = await evaluateGateChain(narrowByFrame(grant), { requestId: 'r-narrow', lens, frame }, fetcher)
        return isSubsetByFactId(narrow.disclosed, wide.disclosed)
      }),
      { numRuns: 1000 },
    )
  }, 60000)

  it('composition: scope + lens narrowing in sequence satisfies transitive subset', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, arbGrant, arbLens, async (facts, grant, lens) => {
        const frame = makeRequestFrame(grant)
        const fetcher = makeFetcher(facts)
        const wideResult = await evaluateGateChain(grant, { requestId: 'r-wide', lens, frame }, fetcher)
        const midResult = await evaluateGateChain(narrowByScope(grant), { requestId: 'r-mid', lens, frame }, fetcher)
        const narrowResult = await evaluateGateChain(narrowByScope(grant), { requestId: 'r-narrow', lens: narrowByLens(lens), frame }, fetcher)
        return (
          isSubsetByFactId(midResult.disclosed, wideResult.disclosed) &&
          isSubsetByFactId(narrowResult.disclosed, midResult.disclosed)
        )
      }),
      { numRuns: 1000 },
    )
  }, 60000)

  it('teeth check: union-mutant widens disclosed — property has real discriminatory power', async () => {
    const now = Math.floor(Date.now() / 1000)
    const grant = createGrant({
      issuer: 'did:key:z6MkTeeth',
      audience: 'did:key:z6MkTeeth',
      scopeExpression: { op: 'EQUALS', field: 'entity_type', value: 'fact' },
      allowedFrames: ['frame-alpha'],
      validity: { iat: now - 60, exp: now + 3600 },
    })
    const lens: Lens = {
      id: 'lens-teeth',
      role: 'analyst',
      jurisdiction: 'us',
      entityTypes: ['fact', 'claim'],
    }
    const frame: Frame = {
      id: 'frame-alpha',
      taskSlug: 'teeth',
      intent: 'teeth check',
      nextStep: 'assert',
      requiresApproval: false,
      allowedFrames: [],
    }
    const facts = [
      { id: 'f1', entity_type: 'fact', content: 'a fact', domain: 'general', gates: [], valid_at: null, invalid_at: null },
      { id: 'c1', entity_type: 'claim', content: 'a claim', domain: 'general', gates: [], valid_at: null, invalid_at: null },
    ]
    const fetcher = makeFetcher(facts)

    const original = await evaluateGateChain(grant, { requestId: 'r-original', lens, frame }, fetcher)
    expect(original.disclosed.map(f => f.id)).toEqual(['f1'])

    const mutantGrant = widenByUnion(grant, 'claim')
    const mutant = await evaluateGateChain(mutantGrant, { requestId: 'r-mutant', lens, frame }, fetcher)
    const mutantIds = mutant.disclosed.map(f => f.id as string).sort()
    expect(mutantIds).toEqual(['c1', 'f1'])

    const originalIds = new Set(original.disclosed.map(f => f.id as string))
    const mutantViolatesSubset = mutantIds.some(id => !originalIds.has(id))
    expect(mutantViolatesSubset).toBe(true)
  })
})
