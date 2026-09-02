// src/gci.ts
/** Grid Convergence Index study (Celik et al. 2008) over ≥3 mesh levels.
 * Pure math — no IO, no stages; verify-mesh feeds it level results. */

export interface GciLevel {
  /** Characteristic element/cell size; any consistent unit (mm). */
  size: number
  /** Element/cell count at this level — drives the refinement ratio. */
  count: number
  /** The monitored scalar metric (e.g. max von Mises in MPa). */
  value: number
}

export interface GciResult {
  refinementRatios: { r21: number; r32: number }
  convergenceState: 'monotonic' | 'oscillatory'
  observedOrder: number | null
  richardsonExtrapolated: number | null
  gciFinePercent: number | null
  gciCoarsePercent: number | null
  meshIndependent: boolean
  thresholdPercent: number
}

/**
 * Study ≥3 mesh levels with the Celik et al. (2008) procedure. Levels are
 * sorted finest-first internally; refinement ratios come from cell-count cube
 * roots. Oscillatory convergence (non-monotonic values) yields null order/GCI
 * and meshIndependent=false — the numbers cannot be trusted.
 */
export function gci(levelsIn: GciLevel[], thresholdPercent: number): GciResult {
  if (levelsIn.length < 3) {
    throw new Error(`GCI needs at least 3 mesh levels, got ${levelsIn.length}`)
  }
  const levels = [...levelsIn].sort((a, b) => a.size - b.size) // index 1 = finest
  const [l1, l2, l3] = levels
  const r21 = Math.cbrt(l1.count / l2.count)
  const r32 = Math.cbrt(l2.count / l3.count)
  const e21 = l2.value - l1.value
  const e32 = l3.value - l2.value
  const base = {
    refinementRatios: { r21, r32 },
    thresholdPercent,
  }
  const monotonic = Math.abs(l1.value) > 0 && e21 * e32 > 0
  if (!monotonic) {
    return {
      ...base,
      convergenceState: 'oscillatory',
      observedOrder: null,
      richardsonExtrapolated: null,
      gciFinePercent: null,
      gciCoarsePercent: null,
      meshIndependent: false,
    }
  }
  const p = solveOrder(r21, r32, e21, e32)
  const richardsonExtrapolated = l1.value - e21 / (r21 ** p - 1)
  const gciFinePercent = 1.25 * Math.abs(e21) / (Math.abs(l1.value) * (r21 ** p - 1)) * 100
  const gciCoarsePercent = 1.25 * Math.abs(e32) / (Math.abs(l2.value) * (r32 ** p - 1)) * 100
  return {
    ...base,
    convergenceState: 'monotonic',
    observedOrder: p,
    richardsonExtrapolated,
    gciFinePercent,
    gciCoarsePercent,
    meshIndependent: gciFinePercent <= thresholdPercent,
  }
}

/** Fixed-point iteration for the observed order p (Celik Eq. 14–16); with
 * equal ratios it reduces to p = ln|ε32/ε21| / ln r in one step. */
function solveOrder(r21: number, r32: number, e21: number, e32: number): number {
  const s = Math.sign(e32 / e21)
  let p = 2
  for (let i = 0; i < 100; i += 1) {
    const q = Math.log((r21 ** p - s) / (r32 ** p - s))
    const next = (Math.log(Math.abs(e32 / e21)) + q) / Math.log(r21)
    if (Math.abs(next - p) < 1e-12) return next
    p = next
  }
  return p
}
