// tests/gci.test.ts
import { describe, expect, it } from 'vitest'
import { gci } from '../src/gci.ts'
import type { GciLevel } from '../src/gci.ts'

// 制造解：φ = φ_ext + C·N^(−p/3)，count 取 (27000, 8000, 2370.37…) 精确比例 1.5³
const manufactured = (p: number, phiExt = 100, c = 1): GciLevel[] => {
  const mk = (n: number): GciLevel => ({ size: 1 / Math.cbrt(n), count: n, value: phiExt + c * n ** (-p / 3) })
  return [mk(27000), mk(8000), mk(8000 / 3.375), mk(8000 / 3.375 / 3.375)].slice(0, 3)
}

describe('gci', () => {
  it('recovers the manufactured observed order exactly for equal ratios', () => {
    const result = gci(manufactured(3), 3)
    expect(result.convergenceState).toBe('monotonic')
    expect(result.observedOrder).toBeCloseTo(3, 4)
    expect(result.richardsonExtrapolated).toBeCloseTo(100, 6)
    expect(result.meshIndependent).toBe(true)
  })

  it('computes the fine-grid GCI by the Celik formula', () => {
    const result = gci(manufactured(2, 100, 1), 3)
    // φ1 = 100 + 27000^(−2/3), φ2 = 100 + 8000^(−2/3); r = 1.5, p = 2
    const phi1 = 100 + 27000 ** (-2 / 3)
    const phi2 = 100 + 8000 ** (-2 / 3)
    const expectGci = 1.25 * Math.abs(phi2 - phi1) / (Math.abs(phi1) * (1.5 ** 2 - 1)) * 100
    expect(result.gciFinePercent).toBeCloseTo(expectGci, 6)
    expect(result.observedOrder).toBeCloseTo(2, 4)
  })

  it('flags oscillatory convergence as unreliable', () => {
    const levels: GciLevel[] = [
      { size: 1, count: 9000, value: 100 },
      { size: 1.5, count: 3000, value: 100.5 },
      { size: 2, count: 1000, value: 100.2 },
    ]
    const result = gci(levels, 3)
    expect(result.convergenceState).toBe('oscillatory')
    expect(result.observedOrder).toBeNull()
    expect(result.gciFinePercent).toBeNull()
    expect(result.meshIndependent).toBe(false)
  })

  it('respects the threshold: a large fine-grid GCI is not mesh-independent', () => {
    const result = gci(manufactured(2, 100, 50), 0.01)  // C=50 放大离散误差
    expect(result.meshIndependent).toBe(false)
    expect(result.gciFinePercent!).toBeGreaterThan(0.01)
  })

  it('throws below three levels', () => {
    expect(() => gci([{ size: 1, count: 10, value: 1 }, { size: 2, count: 5, value: 2 }], 3))
      .toThrow('at least 3')
  })

  it('accepts unsorted input (finest may come last)', () => {
    const sorted = manufactured(3)
    const result = gci([...sorted].reverse(), 3)
    expect(result.observedOrder).toBeCloseTo(3, 4)
  })
})
