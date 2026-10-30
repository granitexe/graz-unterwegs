export type ScreenRect = { left: number; top: number; right: number; bottom: number }

/** Intersect the direction from the free rectangle's centre with the chip-safe inset. */
export function placeEdgeIndicator(target: { x: number; y: number }, rect: ScreenRect, chip: { width: number; height: number }): { x: number; y: number; angleDeg: number } | null {
  const values = [target.x, target.y, rect.left, rect.top, rect.right, rect.bottom, chip.width, chip.height]
  if (!values.every(Number.isFinite) || chip.width <= 0 || chip.height <= 0 || rect.right <= rect.left || rect.bottom <= rect.top) return null
  if (target.x >= rect.left && target.x <= rect.right && target.y >= rect.top && target.y <= rect.bottom) return null
  const left = rect.left + chip.width / 2 + 8, right = rect.right - chip.width / 2 - 8
  const top = rect.top + chip.height / 2 + 8, bottom = rect.bottom - chip.height / 2 - 8
  if (left > right || top > bottom) return null
  const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2
  const dx = target.x - cx, dy = target.y - cy
  const tx = dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity
  const ty = dy > 0 ? (bottom - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity
  const scale = Math.min(tx, ty)
  return { x: cx + dx * scale, y: cy + dy * scale, angleDeg: Math.atan2(dx, -dy) * 180 / Math.PI }
}
