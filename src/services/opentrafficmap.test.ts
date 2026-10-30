import { afterEach, describe, expect, it, vi } from 'vitest'
import { cityTiles, connectVehicles, positionStatus, TiledVehicleState } from './opentrafficmap'

const now = Date.parse('2026-10-30T12:00:00Z')
const tiles = cityTiles()
const point = (id: string, lon = 15.4395, seen = now) => ({
  id, type: 'Feature', geometry: { type: 'Point', coordinates: [lon, 47.0707] },
  properties: { kind: 'bus', transitCity: 'Graz', lastSeen: new Date(seen).toISOString(), transitLineDisplay: '52Z', transitTargetName: 'Eggenberg/UKH', vehicleNumber: '42', headingDeg: 90 },
})
const snapshot = (tile: string, seq: number, points: Record<string, unknown>) => ({ type: 'tile-fullstatus', generation: 1, tile, seq, state: { points } })

describe('OpenTrafficMap tiled state', () => {
  it('applies dictionary patches atomically, preserving fields and removing properties', () => {
    const resync = vi.fn(), state = new TiledVehicleState(tiles, resync), tile = tiles[0]
    state.apply(snapshot(tile, 1, { a: point('a') }))
    expect(state.apply({ type: 'tile-delta-batch', deltas: [{ tile, baseSeq: 1, seq: 2, patchPointIds: ['a'] }], pointPatchesById: { a: { id: 'a', geometry: { type: 'Point', coordinates: [15.44, 47.0707] }, properties: { transitLineDisplay: '63' }, removeProperties: ['vehicleNumber'] } } })).toBe(true)
    expect(state.observations(now)).toEqual([expect.objectContaining({ id: 'a', coordinate: { lat: 47.0707, lon: 15.44 }, lineDisplay: '63', targetName: 'Eggenberg/UKH', heading: 90 })])
    expect(state.observations(now)[0].vehicleNumber).toBeUndefined()
    expect(resync).not.toHaveBeenCalled()
  })
  it('requests a replacement on a sequence gap or missing patch base and refuses further deltas', () => {
    const resync = vi.fn(), state = new TiledVehicleState(tiles, resync), tile = tiles[0]
    state.apply(snapshot(tile, 1, { a: point('a') }))
    state.apply({ type: 'tile-delta', tile, baseSeq: 3, seq: 4, upsertPoints: [point('a', 15.45)] })
    state.apply({ type: 'tile-delta', tile, baseSeq: 1, seq: 2, upsertPoints: [point('a', 15.46)] })
    expect(resync).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledWith(tile)
    expect(state.observations(now)[0].coordinate.lon).toBe(15.4395)
    state.apply(snapshot(tile, 5, { a: point('a') }))
    state.apply({ type: 'tile-delta', tile, baseSeq: 5, seq: 6, patchPoints: [{ id: 'missing' }] })
    expect(resync).toHaveBeenCalledTimes(2)
  })
  it('retains duplicate tile vehicles until all tiles remove them and selects the newest', () => {
    const state = new TiledVehicleState(tiles, vi.fn()), [a, b] = tiles
    state.apply(snapshot(a, 1, { v: point('v', 15.4395, now - 1000) }))
    state.apply(snapshot(b, 1, { v: point('v', 15.44, now) }))
    expect(state.observations(now)[0].coordinate.lon).toBe(15.44)
    state.apply({ type: 'tile-delta', tile: b, baseSeq: 1, seq: 2, removePoints: ['v'] })
    expect(state.observations(now)[0].coordinate.lon).toBe(15.4395)
    state.apply({ type: 'tile-delta', tile: a, baseSeq: 1, seq: 2, removePoints: ['v'] })
    expect(state.observations(now)).toEqual([])
  })
  it('ignores non-vehicles, out-of-city points, unsupported messages and invalid timestamps', () => {
    const state = new TiledVehicleState(tiles, vi.fn()), tile = tiles[0]
    const wrongCity = point('other'); wrongCity.properties.transitCity = 'Vienna'
    const invalid = point('invalid'); invalid.properties.lastSeen = 'invalid'
    state.apply(snapshot(tile, 1, { a: point('a'), other: wrongCity, invalid, outside: point('outside', 16) }))
    expect(state.apply({ type: 'tile-ready', tile })).toBe(false)
    expect(state.apply({ type: 'unknown', points: [point('fake')] })).toBe(false)
    expect(state.observations(now).map(v => v.id)).toEqual(['a'])
  })
  it('classifies age and rejects invalid and future observations', () => {
    expect(positionStatus(now - 30000, now)).toBe('fresh')
    expect(positionStatus(now - 31000, now)).toBe('stale')
    expect(positionStatus(now - 121000, now)).toBe('missing')
    expect(positionStatus(NaN, now)).toBe('missing')
    expect(positionStatus(now + 5001, now)).toBe('missing')
  })
})

describe('socket lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('subscribes, reconnects after silence, pauses hidden tabs, and cleans up', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const documentEvents = new EventTarget() as EventTarget & { hidden: boolean }
    documentEvents.hidden = false
    const windowEvents = new EventTarget()
    class Socket {
      static OPEN = 1
      static instances: Socket[] = []
      readyState = 1
      sent: string[] = []
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      constructor(_url: string) { Socket.instances.push(this) }
      send(value: string) { this.sent.push(value) }
      close() { this.readyState = 3 }
    }
    vi.stubGlobal('document', documentEvents)
    vi.stubGlobal('window', windowEvents)
    vi.stubGlobal('WebSocket', Socket)
    const update = vi.fn()
    const dispose = connectVehicles(update)
    const first = Socket.instances[0]
    first.onopen?.()
    expect(JSON.parse(first.sent[0])).toEqual({ type: 'subscribe-tiles', generation: 1, tiles })
    first.onmessage?.({ data: JSON.stringify({ ...snapshot(tiles[0], 1, { a: point('a') }), now }) })
    expect(update.mock.lastCall?.[1].state).toBe('connected')
    vi.advanceTimersByTime(30000)
    expect(update.mock.lastCall?.[1].state).toBe('disconnected')
    vi.advanceTimersByTime(1000)
    expect(Socket.instances).toHaveLength(2)
    documentEvents.hidden = true
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(update.mock.lastCall?.[1].state).toBe('paused')
    expect(Socket.instances[1].readyState).toBe(3)
    documentEvents.hidden = false
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(Socket.instances).toHaveLength(3)
    dispose()
    vi.advanceTimersByTime(60000)
    expect(Socket.instances).toHaveLength(3)
    expect(Socket.instances[2].readyState).toBe(3)
  })
})
