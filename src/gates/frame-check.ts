import type { Grant } from '../types.js'

export interface FrameCheckResult {
  pass: boolean
  reasonCode?: string
}

export function applyFrameCheck(grant: Grant, frameId: string): FrameCheckResult {
  if (grant.allowedFrames.includes(frameId)) {
    return { pass: true }
  }
  return { pass: false, reasonCode: 'frame-not-authorized' }
}
