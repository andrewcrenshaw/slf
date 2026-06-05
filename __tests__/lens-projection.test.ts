import { applyLensProjection } from '../src/gates/lens-projection.js'
import type { Lens } from '../src/types.js'

function makeLens(overrides: Partial<Lens> = {}): Lens {
  return {
    id: 'lens-1',
    role: 'analyst',
    jurisdiction: 'us',
    entityTypes: ['decision', 'fact'],
    ...overrides,
  }
}

describe('lens-projection', () => {
  const facts = [
    { id: '1', entity_type: 'decision', content: 'decided something' },
    { id: '2', entity_type: 'fact', content: 'factual content' },
    { id: '3', entity_type: 'claim', content: 'a claim' },
  ]

  it('passes facts whose entity_type is in the lens entityTypes', () => {
    const lens = makeLens()
    const result = applyLensProjection(lens, facts)
    expect(result.disclosed.length).toBe(2)
    expect(result.disclosed.map(f => f.entity_type)).toEqual(['decision', 'fact'])
  })

  it('filters out a claim row not in the lens contract', () => {
    const lens = makeLens()
    const result = applyLensProjection(lens, facts)
    expect(result.redacted.length).toBe(1)
    expect(result.redacted[0].fact.entity_type).toBe('claim')
    expect(result.redacted[0].reasonCode).toBe('entity-type-excluded')
  })

  it('allows all facts when entityTypes is empty (open lens)', () => {
    const lens = makeLens({ entityTypes: [] })
    const result = applyLensProjection(lens, facts)
    expect(result.disclosed.length).toBe(3)
    expect(result.redacted.length).toBe(0)
  })

  it('redacts all facts when no entity_type matches', () => {
    const lens = makeLens({ entityTypes: ['lesson'] })
    const result = applyLensProjection(lens, facts)
    expect(result.disclosed.length).toBe(0)
    expect(result.redacted.length).toBe(3)
  })
})
