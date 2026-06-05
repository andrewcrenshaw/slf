export type ScopeExpression =
  | { op: 'AND'; args: [ScopeExpression, ScopeExpression] }
  | { op: 'OR'; args: [ScopeExpression, ScopeExpression] }
  | { op: 'NOT'; arg: ScopeExpression }
  | { op: 'EQUALS'; field: string; value: unknown }
  | { op: 'WITHIN'; field: string; set: unknown[] }
  | { op: 'MATCHES'; field: string; pattern: string }

export interface Grant {
  id: string
  issuer: string
  audience: string
  grantType: 'read'
  scopeExpression: ScopeExpression
  allowedFrames: string[]
  validity: { iat: number; exp: number }
  signature?: string
}

export interface OkpPublicJwk {
  kty: 'OKP'
  crv: 'Ed25519'
  x: string
}

export interface KeyPair {
  did: string
  publicJwk: OkpPublicJwk
  secretKey: Uint8Array
}

export interface SubstrateReader {
  query(grant: Grant, fact: Record<string, unknown>): Promise<unknown[]>
}

export interface Lens {
  id: string
  role: string
  jurisdiction: string
  entityTypes: string[]
}

export interface Frame {
  id: string
  taskSlug: string
  intent: string
  nextStep: string
  requiresApproval: boolean
  allowedFrames: string[]
}

export type GateOutcome = 'granted' | 'denied' | 'partial' | 'pending_approval' | 'error'

export interface GateResult {
  outcome: GateOutcome
  reasonCode?: string
  disclosedFields?: string[]
  redactedFields?: string[]
  gatesEvaluated?: string[]
}

export interface Receipt {
  id: string
  grantRef: string
  outcome: GateOutcome
  reasonCode?: string
  disclosedFields?: string[]
  redactedFields?: string[]
  actorSignature?: string
  prevReceiptId?: string
  chainId?: string
  timestamp: number
}
