import type { Lens } from '../types.js'

export interface LensProjectionResult {
  disclosed: Array<Record<string, unknown>>
  redacted: Array<{ fact: Record<string, unknown>; reasonCode: string }>
}

export function applyLensProjection(
  lens: Lens,
  facts: Array<Record<string, unknown>>,
): LensProjectionResult {
  const disclosed: Array<Record<string, unknown>> = []
  const redacted: Array<{ fact: Record<string, unknown>; reasonCode: string }> = []

  for (const fact of facts) {
    const entityType = typeof fact.entity_type === 'string' ? fact.entity_type : ''
    if (lens.entityTypes.length === 0 || lens.entityTypes.includes(entityType)) {
      disclosed.push(fact)
    } else {
      redacted.push({ fact, reasonCode: 'entity-type-excluded' })
    }
  }

  return { disclosed, redacted }
}
