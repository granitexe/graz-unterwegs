import { describe, expect, it } from 'vitest'
import type { Journey, TransitLeg, WalkingLeg } from '../domain/types'
import { initialJourneyState, journeyReducer } from './journey'

const place = (name: string) => ({ name, lat: 47.07, lon: 15.44, stopId: name })
const base = { startTime: '2026-10-30T10:00:00Z', endTime: '2026-10-30T10:10:00Z', scheduledStartTime: '2026-10-30T10:00:00Z', scheduledEndTime: '2026-10-30T10:10:00Z', realTime: false, scheduled: true, duration: 600, from: place('A'), to: place('B'), legGeometry: { points: '', precision: 6, length: 0 } }
const walk: WalkingLeg = { ...base, mode: 'WALK' }
const transit: TransitLeg = { ...base, mode: 'TRAM', tripId: 'first', routeId: '1', directionId: '0', routeShortName: '1', headsign: 'B' }
const journey: Journey = { id: 'journey', duration: 1200, startTime: base.startTime, endTime: base.endTime, transfers: 0, legs: [walk, transit] }

describe('journey tracking state', () => {
  it('selects a route and inspects valid legs without changing the route', () => {
    const selected = journeyReducer(initialJourneyState, { type: 'select', journey })
    expect(selected).toEqual({ journey, selectedLegIndex: null, pinnedVehicleId: null })
    const inspected = journeyReducer(selected, { type: 'select-leg', index: 1 })
    expect(inspected.selectedLegIndex).toBe(1)
    for (const index of [-1, 2, 0.5, NaN]) expect(journeyReducer(inspected, { type: 'select-leg', index })).toBe(inspected)
    expect(journeyReducer(inspected, { type: 'select-leg', index: null }).journey).toBe(journey)
  })
  it('clears pins on changed selection, expiration, and reset', () => {
    let state = journeyReducer(initialJourneyState, { type: 'select', journey })
    state = journeyReducer(state, { type: 'pin', vehicleId: 'v' })
    expect(journeyReducer(state, { type: 'select-leg', index: 1 }).pinnedVehicleId).toBeNull()
    expect(journeyReducer(state, { type: 'expire-pin' }).pinnedVehicleId).toBeNull()
    expect(journeyReducer(state, { type: 'select', journey }).pinnedVehicleId).toBeNull()
    expect(journeyReducer(state, { type: 'reset' })).toEqual(initialJourneyState)
  })
  it('accepts same-itinerary event refresh but rejects changed trips or structure', () => {
    let state = journeyReducer(initialJourneyState, { type: 'select', journey })
    state = journeyReducer(state, { type: 'select-leg', index: 1 })
    state = journeyReducer(state, { type: 'pin', vehicleId: 'v' })
    const updated = { ...journey, legs: [walk, { ...transit, cancelled: true }] }
    const refreshed = journeyReducer(state, { type: 'refresh', journey: updated })
    expect(refreshed).toEqual({ journey: updated, selectedLegIndex: 1, pinnedVehicleId: 'v' })
    expect(journeyReducer(refreshed, { type: 'refresh', journey: { ...updated, legs: [walk, { ...transit, tripId: 'other' }] } })).toBe(refreshed)
    expect(journeyReducer(refreshed, { type: 'refresh', journey: { ...updated, id: 'other' } })).toBe(refreshed)
    expect(journeyReducer(refreshed, { type: 'refresh', journey: { ...updated, legs: [transit] } })).toBe(refreshed)
  })
})
