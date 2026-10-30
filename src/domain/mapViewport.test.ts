import { describe, expect, it } from 'vitest'
import { placeEdgeIndicator } from './mapViewport'

const rect = { left: 0, top: 0, right: 400, bottom: 300 }
const chip = { width: 80, height: 40 }
describe('placeEdgeIndicator', () => {
  it('ignores targets inside or on the visible boundary', () => {
    expect(placeEdgeIndicator({ x: 200, y: 150 }, rect, chip)).toBeNull()
    expect(placeEdgeIndicator({ x: 0, y: 100 }, rect, chip)).toBeNull()
  })
  it.each([
    [{ x: 200, y: -100 }, 200, 28, 0],
    [{ x: 600, y: 150 }, 352, 150, 90],
    [{ x: 200, y: 500 }, 200, 272, 180],
    [{ x: -200, y: 150 }, 48, 150, -90],
  ])('places axis-aligned targets', (target, x, y, angle) => {
    expect(placeEdgeIndicator(target, rect, chip)).toEqual({ x, y, angleDeg: angle })
  })
  it.each([{ x: -400, y: -300 }, { x: 800, y: -300 }, { x: -400, y: 600 }, { x: 800, y: 600 }])('preserves diagonal direction and containment', target => {
    const result = placeEdgeIndicator(target, rect, chip)!
    expect(result.x).toBeGreaterThanOrEqual(48)
    expect(result.x).toBeLessThanOrEqual(352)
    expect(result.y).toBeGreaterThanOrEqual(28)
    expect(result.y).toBeLessThanOrEqual(272)
    expect((result.x - 200) * (target.y - 150)).toBeCloseTo((result.y - 150) * (target.x - 200))
    expect(result.angleDeg).toBeCloseTo(Math.atan2(target.x - 200, 150 - target.y) * 180 / Math.PI)
  })
  it('accounts for measured dimensions and rejects invalid or insufficient space', () => {
    expect(placeEdgeIndicator({ x: 600, y: 150 }, rect, { width: 160, height: 60 })?.x).toBe(312)
    expect(placeEdgeIndicator({ x: Infinity, y: 0 }, rect, chip)).toBeNull()
    expect(placeEdgeIndicator({ x: 600, y: 150 }, rect, { width: 400, height: 40 })).toBeNull()
    expect(placeEdgeIndicator({ x: 600, y: 150 }, rect, { width: NaN, height: 40 })).toBeNull()
  })
})
