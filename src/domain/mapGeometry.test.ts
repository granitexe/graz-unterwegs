import { describe, expect, it } from 'vitest'
import polyline from '@mapbox/polyline'
import { buildJourneyFeatures } from './mapGeometry'
import type { Journey, Place, TransitLeg, WalkingLeg } from './types'

const a: Place = { name: 'A', stopId: 'a', lat: 47.07, lon: 15.43 }
const b: Place = { name: 'B', stopId: 'b', lat: 47.071, lon: 15.44 }
const c: Place = { name: 'C', stopId: 'c', lat: 47.072, lon: 15.45 }
const time = '2026-10-30T10:00:00Z'
const base = { startTime: time, endTime: time, scheduledStartTime: time, scheduledEndTime: time, realTime: false, scheduled: true, duration: 60 }
const encoded = (from: Place, to: Place) => ({ points: polyline.encode([[from.lat, from.lon], [to.lat, to.lon]], 6), precision: 6, length: 2 })
const walk: WalkingLeg = { ...base, mode: 'WALK', from: a, to: b, legGeometry: encoded(a, b) }
const bus: TransitLeg = { ...base, mode: 'BUS', from: b, to: c, legGeometry: encoded(b, c), tripId: 'trip', routeId: 'route', directionId: '0', routeShortName: '63', headsign: 'C' }
const journey = (legs: Journey['legs']): Journey => ({ id: 'j', duration: 120, startTime: time, endTime: time, transfers: 0, legs })

describe('buildJourneyFeatures', () => {
  it('decodes precision six in longitude-latitude order for a direct walk', () => {
    const result = buildJourneyFeatures(journey([walk]), null)
    expect(result.routes.features[0].geometry.coordinates).toEqual([[15.43, 47.07], [15.44, 47.071]])
    expect(result.routes.features[0].properties).toMatchObject({ legIndex: 0, walk: true, selected: true })
    expect(result.unavailableLegIndices).toEqual([])
  })
  it('retains good legs and stops when another geometry is malformed', () => {
    const result = buildJourneyFeatures(journey([{ ...walk, legGeometry: { points: '', precision: 6, length: 0 } }, bus]), 1)
    expect(result.unavailableLegIndices).toEqual([0])
    expect(result.routes.features).toHaveLength(1)
    expect(result.routes.features[0].properties.legIndex).toBe(1)
    expect(result.stops.features).toHaveLength(2)
  })
  it('merges alighting and boarding into one transfer by stop identity', () => {
    const next: TransitLeg = { ...bus, from: c, to: a, tripId: 'next', legGeometry: encoded(c, a) }
    const result = buildJourneyFeatures(journey([bus, next]), 1)
    const transfer = result.stops.features.find(feature => feature.properties.label === 'C')
    expect(transfer?.properties).toMatchObject({ board: true, alight: true, transfer: true, selected: true })
    expect(result.stops.features).toHaveLength(3)
  })
  it('shows each segment’s intermediate stops in overview and when another leg is inspected', () => {
    const middle1: Place = { name: 'Middle 1', lat: 47.0714, lon: 15.442 }
    const middle2: Place = { name: 'Middle 2', lat: 47.0717, lon: 15.447 }
    const first: TransitLeg = { ...bus, intermediateStops: [middle1], legGeometry: { points: '', precision: 6, length: 0 } }
    const second: TransitLeg = { ...bus, from: c, to: a, tripId: 'next', intermediateStops: [middle2], legGeometry: encoded(c, a) }
    const overview = buildJourneyFeatures(journey([first, second]), null)
    expect(overview.unavailableLegIndices).toEqual([0])
    expect(overview.stops.features.find(f => f.properties.label === 'Middle 1')?.properties).toMatchObject({ intermediate: true, selected: true })
    expect(overview.stops.features.find(f => f.properties.label === 'Middle 2')?.properties).toMatchObject({ intermediate: true, selected: true })
    const inspected = buildJourneyFeatures(journey([first, second]), 1)
    expect(inspected.stops.features.find(f => f.properties.label === 'Middle 1')?.properties.selected).toBe(false)
    expect(inspected.stops.features.find(f => f.properties.label === 'Middle 2')?.properties.selected).toBe(true)
  })
})
