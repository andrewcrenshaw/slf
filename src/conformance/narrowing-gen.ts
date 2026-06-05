import * as fc from 'fast-check'
import type { Grant, Lens, Frame, ScopeExpression } from '../types.js'
import { createGrant } from '../grant.js'

export const ENTITY_TYPES = ['fact', 'decision', 'claim', 'insight'] as const
export const DOMAINS = ['general', 'health', 'finance'] as const
export const FRAME_POOL = ['frame-alpha', 'frame-beta', 'frame-gamma'] as const

export const arbFact: fc.Arbitrary<Record<string, unknown>> = fc.record({
  id: fc.hexaString({ minLength: 6, maxLength: 10 }),
  entity_type: fc.constantFrom(...ENTITY_TYPES),
  content: fc.string({ maxLength: 16 }),
  domain: fc.constantFrom(...DOMAINS),
  gates: fc.constant([] as string[]),
  valid_at: fc.constant(null),
  invalid_at: fc.constant(null),
})

export const arbFacts: fc.Arbitrary<Array<Record<string, unknown>>> = fc.array(arbFact, {
  minLength: 0,
  maxLength: 8,
})

export const arbLens: fc.Arbitrary<Lens> = fc.record({
  entityTypes: fc.subarray([...ENTITY_TYPES], { minLength: 1 }),
}).map(({ entityTypes }) => ({
  id: 'lens-prop',
  role: 'analyst',
  jurisdiction: 'us',
  entityTypes,
}))

export const arbGrant: fc.Arbitrary<Grant> = fc.record({
  entityTypeValue: fc.constantFrom(...ENTITY_TYPES),
  framePool: fc.subarray([...FRAME_POOL], { minLength: 1 }),
}).map(({ entityTypeValue, framePool }) => {
  const now = Math.floor(Date.now() / 1000)
  return createGrant({
    issuer: 'did:key:z6MkPropIssuer',
    audience: 'did:key:z6MkPropAudience',
    scopeExpression: { op: 'EQUALS', field: 'entity_type', value: entityTypeValue },
    allowedFrames: [...framePool],
    validity: { iat: now - 60, exp: now + 3600 },
  })
})

export const arbFrame: fc.Arbitrary<Frame> = fc.constantFrom(...FRAME_POOL).map(id => ({
  id,
  taskSlug: 'prop-test',
  intent: 'property suite',
  nextStep: 'assert',
  requiresApproval: false,
  allowedFrames: [],
}))

/** Returns a Frame keyed to the grant's first allowedFrame — use in property tests. */
export function makeRequestFrame(grant: Grant): Frame {
  return {
    id: grant.allowedFrames[0],
    taskSlug: 'prop-test',
    intent: 'property suite',
    nextStep: 'assert',
    requiresApproval: false,
    allowedFrames: [],
  }
}

/** Narrows scope by AND-ing EQUALS domain 'general' onto the existing scopeExpression. */
export function narrowByScope(grant: Grant): Grant {
  const narrower: ScopeExpression = {
    op: 'AND',
    args: [grant.scopeExpression, { op: 'EQUALS', field: 'domain', value: 'general' }],
  }
  return { ...grant, scopeExpression: narrower }
}

/** Narrows a lens by dropping its last entityType; returns the lens unchanged if only one type. */
export function narrowByLens(lens: Lens): Lens {
  if (lens.entityTypes.length <= 1) return lens
  return { ...lens, entityTypes: lens.entityTypes.slice(0, -1) }
}

/**
 * Narrows a grant by dropping its first allowedFrame (the one makeRequestFrame picks),
 * so the caller's request frame is no longer authorized. Returns the grant unchanged
 * when only one frame exists.
 */
export function narrowByFrame(grant: Grant): Grant {
  if (grant.allowedFrames.length <= 1) return grant
  return { ...grant, allowedFrames: grant.allowedFrames.slice(1) }
}

/** Union-widening MUTANT — widens scopeExpression with OR. Violates monotonic narrowing. */
export function widenByUnion(grant: Grant, extraEntityType: string): Grant {
  const widened: ScopeExpression = {
    op: 'OR',
    args: [grant.scopeExpression, { op: 'EQUALS', field: 'entity_type', value: extraEntityType }],
  }
  return { ...grant, scopeExpression: widened }
}
