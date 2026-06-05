export type HitlOutcome = 'pass' | 'pending_approval' | 'denied'

export interface HitlGateResult {
  outcome: HitlOutcome
  disclosurePreview?: string
  reasonCode?: string
}

export function applyHitlGate(
  requiresApproval: boolean,
  requestId: string,
  disclosed: Array<Record<string, unknown>>,
  approvalToken?: string,
): HitlGateResult {
  if (!requiresApproval) {
    return { outcome: 'pass' }
  }

  if (!approvalToken) {
    return {
      outcome: 'pending_approval',
      disclosurePreview: `${disclosed.length} fact(s) pending review for request ${requestId}`,
    }
  }

  if (approvalToken.startsWith('approve:')) {
    return { outcome: 'pass' }
  }

  if (approvalToken.startsWith('deny:')) {
    return { outcome: 'denied', reasonCode: 'approval-denied' }
  }

  return {
    outcome: 'pending_approval',
    disclosurePreview: `invalid approval token for request ${requestId}`,
  }
}
