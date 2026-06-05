import type { Grant, ScopeExpression } from '../types.js'
import { evaluate } from '../scope-eval.js'

const RESTRICTIVE_GATE_TAGS = ['health-data', 'personal-data', 'audience-restricted']

export interface SubstrateGateResult {
  pass: boolean
  reasonCode?: string
}

function scopeReferencesField(expr: ScopeExpression, field: string): boolean {
  switch (expr.op) {
    case 'AND':
      return scopeReferencesField(expr.args[0], field) || scopeReferencesField(expr.args[1], field)
    case 'OR':
      return scopeReferencesField(expr.args[0], field) || scopeReferencesField(expr.args[1], field)
    case 'NOT':
      return scopeReferencesField(expr.arg, field)
    case 'EQUALS':
    case 'WITHIN':
    case 'MATCHES':
      return expr.field === field
  }
}

export function applySubstrateGate(
  grant: Grant,
  fact: Record<string, unknown>,
): SubstrateGateResult {
  const now = Math.floor(Date.now() / 1000)

  // Step 1a: future valid_at
  if (typeof fact.valid_at === 'number' && fact.valid_at > now) {
    return { pass: false, reasonCode: 'fact-not-yet-valid' }
  }

  // Step 1b: expired invalid_at
  if (typeof fact.invalid_at === 'number' && fact.invalid_at <= now) {
    return { pass: false, reasonCode: 'fact-expired' }
  }

  // Step 1c: scope expression
  if (!evaluate(grant.scopeExpression, fact)) {
    return { pass: false, reasonCode: 'scope-mismatch' }
  }

  // Step 1d: restrictive gate tags — grant must explicitly reference the 'gates' field
  const factGates = Array.isArray(fact.gates)
    ? (fact.gates as string[])
    : typeof fact.gates === 'string'
      ? [fact.gates as string]
      : []
  const hasRestrictiveTag = factGates.some(t => RESTRICTIVE_GATE_TAGS.includes(t))
  if (hasRestrictiveTag && !scopeReferencesField(grant.scopeExpression, 'gates')) {
    return { pass: false, reasonCode: 'gate-tag-restricted' }
  }

  return { pass: true }
}
