import type { ScopeExpression } from './types.js'

export function evaluate(expr: ScopeExpression, fact: Record<string, unknown>): boolean {
  switch (expr.op) {
    case 'AND':
      return evaluate(expr.args[0], fact) && evaluate(expr.args[1], fact)
    case 'OR':
      return evaluate(expr.args[0], fact) || evaluate(expr.args[1], fact)
    case 'NOT':
      return !evaluate(expr.arg, fact)
    case 'EQUALS':
      return fact[expr.field] === expr.value
    case 'WITHIN':
      return expr.set.includes(fact[expr.field])
    case 'MATCHES': {
      const val = fact[expr.field]
      if (typeof val !== 'string') return false
      return new RegExp(expr.pattern).test(val)
    }
  }
}
