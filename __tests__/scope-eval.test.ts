import { evaluate } from '../src/scope-eval.js'

const fact = {
  type: 'lesson',
  score: 85,
  tags: ['health', 'finance'],
  domain: 'personal',
  label: 'intro-to-budgeting',
}

describe('scope-eval', () => {
  describe('EQUALS', () => {
    it('returns true when field matches value', () => {
      expect(evaluate({ op: 'EQUALS', field: 'type', value: 'lesson' }, fact)).toBe(true)
    })
    it('returns false when field does not match value', () => {
      expect(evaluate({ op: 'EQUALS', field: 'type', value: 'claim' }, fact)).toBe(false)
    })
  })

  describe('WITHIN', () => {
    it('returns true when field value is in the set', () => {
      expect(evaluate({ op: 'WITHIN', field: 'score', set: [80, 85, 90] }, fact)).toBe(true)
    })
    it('returns false when field value is not in the set', () => {
      expect(evaluate({ op: 'WITHIN', field: 'score', set: [70, 75, 80] }, fact)).toBe(false)
    })
  })

  describe('MATCHES', () => {
    it('returns true when field matches regex pattern', () => {
      expect(evaluate({ op: 'MATCHES', field: 'label', pattern: '^intro' }, fact)).toBe(true)
    })
    it('returns false when field does not match regex pattern', () => {
      expect(evaluate({ op: 'MATCHES', field: 'label', pattern: '^advanced' }, fact)).toBe(false)
    })
  })

  describe('AND', () => {
    it('returns true when both sub-expressions are true', () => {
      expect(
        evaluate(
          {
            op: 'AND',
            args: [
              { op: 'EQUALS', field: 'type', value: 'lesson' },
              { op: 'EQUALS', field: 'domain', value: 'personal' },
            ],
          },
          fact,
        ),
      ).toBe(true)
    })
    it('returns false when one sub-expression is false', () => {
      expect(
        evaluate(
          {
            op: 'AND',
            args: [
              { op: 'EQUALS', field: 'type', value: 'lesson' },
              { op: 'EQUALS', field: 'domain', value: 'professional' },
            ],
          },
          fact,
        ),
      ).toBe(false)
    })
  })

  describe('OR', () => {
    it('returns true when at least one sub-expression is true', () => {
      expect(
        evaluate(
          {
            op: 'OR',
            args: [
              { op: 'EQUALS', field: 'type', value: 'claim' },
              { op: 'EQUALS', field: 'domain', value: 'personal' },
            ],
          },
          fact,
        ),
      ).toBe(true)
    })
    it('returns false when both sub-expressions are false', () => {
      expect(
        evaluate(
          {
            op: 'OR',
            args: [
              { op: 'EQUALS', field: 'type', value: 'claim' },
              { op: 'EQUALS', field: 'domain', value: 'professional' },
            ],
          },
          fact,
        ),
      ).toBe(false)
    })
  })

  describe('NOT', () => {
    it('returns true when inner expression is false', () => {
      expect(
        evaluate({ op: 'NOT', arg: { op: 'EQUALS', field: 'type', value: 'claim' } }, fact),
      ).toBe(true)
    })
    it('returns false when inner expression is true', () => {
      expect(
        evaluate({ op: 'NOT', arg: { op: 'EQUALS', field: 'type', value: 'lesson' } }, fact),
      ).toBe(false)
    })
  })
})
