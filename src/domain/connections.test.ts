import { describe, expect, it } from 'vitest'
import { effectiveEventTime, evaluateConnection, refreshJourneyLeg } from './connections'
import type { Journey, Place, TransitLeg, WalkingLeg } from './types'

const time = (minute: number, second = 0) => `2026-10-30T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`
const place = (stopId: string): Place => ({ name: stopId, stopId, lat: 47.07, lon: 15.44 })
const geometry = { points: '', precision: 6, length: 0 }
function transit(from: string, to: string, start: string, end: string): TransitLeg {
  return { mode: 'BUS', tripId: `${from}-${to}`, routeId: 'route', directionId: '0', routeShortName: '63', headsign: 'Centre', startTime: start, endTime: end, scheduledStartTime: start, scheduledEndTime: end, realTime: true, scheduled: true, duration: 300, from: place(from), to: place(to), legGeometry: geometry }
}
function walking(from: string, to: string, duration: number): WalkingLeg {
  return { mode: 'WALK', startTime: time(5), endTime: time(8), scheduledStartTime: time(5), scheduledEndTime: time(8), realTime: false, scheduled: true, duration, from: place(from), to: place(to), legGeometry: geometry }
}
function journey(departure = time(8)): Journey {
  return { id: 'journey', duration: 900, startTime: time(0), endTime: time(15), transfers: 1, legs: [transit('A', 'B', time(0), time(5)), walking('B', 'C', 180), transit('C', 'D', departure, time(15))] }
}
const now = Date.parse(time(0))

describe('connection feasibility', () => {
  it('uses the buffered walking duration once and accepts equality as tight', () => {
    const missed = evaluateConnection(journey(time(7, 59)), now)
    expect(missed.status).toBe('unreachable')
    expect(missed.transfers[0].readyAt).toBe(Date.parse(time(8)))
    const exact = evaluateConnection(journey(), now)
    expect(exact.transfers[0]).toMatchObject({ status: 'tight', requiredTransferSeconds: 180, slackSeconds: 0 })
    expect(evaluateConnection(journey(time(10)), now).status).toBe('feasible')
  })
  it('checks the entire chain after a delayed arrival', () => {
    const j = journey()
    ;(j.legs[0] as TransitLeg).endTime = time(7)
    expect(evaluateConnection(j, now).status).toBe('unreachable')
    const next = j.legs[2] as TransitLeg
    next.startTime = time(12)
    j.legs.push(walking('D', 'E', 180), transit('E', 'F', time(17), time(20)))
    expect(evaluateConnection(j, now).status).toBe('unreachable')
    ;(j.legs[4] as TransitLeg).startTime = time(18)
    expect(evaluateConnection(j, now).status).toBe('tight')
  })
  it('rejects cancellation and disallowed pickup or alighting', () => {
    for (const mutate of [
      (leg: TransitLeg) => { leg.cancelled = true },
      (leg: TransitLeg) => { leg.from.cancelled = true },
      (leg: TransitLeg) => { leg.from.pickupType = 'NOT_ALLOWED' },
      (leg: TransitLeg) => { leg.to.dropoffType = 'NOT_ALLOWED' },
    ]) {
      const j = journey(); mutate(j.legs[2] as TransitLeg)
      expect(evaluateConnection(j, now).status).toBe('unreachable')
    }
  })
  it('does not reuse a changed platform walk or invent one between stops', () => {
    const j = journey()
    ;(j.legs[2] as TransitLeg).from = { ...place('C'), track: '2', scheduledTrack: '1' }
    expect(evaluateConnection(j, now)).toMatchObject({ status: 'unknown', reason: 'platform-changed' })
    j.legs.splice(1, 1)
    ;(j.legs[1] as TransitLeg).from = place('C')
    expect(evaluateConnection(j, now)).toMatchObject({ status: 'unknown', reason: 'missing-transfer' })
  })
  it('uses a same-platform accepted interval and treats interlining as staying seated', () => {
    const j = journey(); j.legs.splice(1, 1)
    const next = j.legs[1] as TransitLeg
    next.from = place('B')
    expect(evaluateConnection(j, now).transfers[0]).toMatchObject({ requiredTransferSeconds: 180, status: 'tight' })
    next.interlineWithPreviousLeg = true
    next.from.pickupType = 'NOT_ALLOWED'
    expect(evaluateConnection(j, now).transfers[0]).toMatchObject({ requiredTransferSeconds: 0, status: 'feasible', interlined: true })
  })
  it('treats an elapsed arrival as timetable-only and does not call a past departure missed', () => {
    const j = journey(time(10))
    expect(evaluateConnection(j, Date.parse(time(1))).status).toBe('feasible')
    expect(evaluateConnection(j, Date.parse(time(6)))).toMatchObject({ status: 'unknown', reason: 'arrival-unconfirmed' })
    expect(evaluateConnection(j, Date.parse(time(16))).status).toBe('feasible')
  })
  it('reports event provenance independently and honours NO_RT_DATA', () => {
    const leg = journey().legs[0] as TransitLeg
    leg.endTime = time(7); leg.arrivalTimestampReason = 'NO_RT_DATA'
    expect(effectiveEventTime(leg, 'arrival')).toEqual({ timeMs: Date.parse(time(5)), provenance: 'scheduled' })
    leg.arrivalTimestampReason = 'PROPAGATED'
    expect(effectiveEventTime(leg, 'arrival')).toEqual({ timeMs: Date.parse(time(7)), provenance: 'predicted' })
    leg.endTime = 'invalid'
    expect(effectiveEventTime(leg, 'arrival')).toEqual({ timeMs: Date.parse(time(5)), provenance: 'scheduled' })
  })
  it('refreshes only the same trip and slices ordered stops while retaining routed geometry', () => {
    const j = journey()
    const selected = j.legs[2] as TransitLeg
    selected.legGeometry = { points: 'original', precision: 6, length: 2 }
    const trip = transit('X', 'Z', time(9), time(20))
    trip.tripId = selected.tripId
    trip.intermediateStops = [
      { ...place('C'), departure: time(12), scheduledDeparture: time(8), track: '2', scheduledTrack: '1' },
      { ...place('D'), arrival: time(15), scheduledArrival: time(15) },
    ]
    const updated = refreshJourneyLeg(j, 2, trip)
    expect(updated?.legs[1]).toBe(j.legs[1])
    expect(updated?.legs[2]).toMatchObject({ tripId: selected.tripId, duration: 180, legGeometry: selected.legGeometry, from: { track: '2', scheduledTrack: '1' } })
    expect(updated && evaluateConnection(updated, now)).toMatchObject({ status: 'unknown', reason: 'platform-changed' })
    expect(refreshJourneyLeg(j, 2, { ...trip, tripId: 'other' })).toBeNull()
    expect(refreshJourneyLeg(j, 2, { ...trip, intermediateStops: [...trip.intermediateStops].reverse() })).toBeNull()
    expect(refreshJourneyLeg(j, 2, { ...trip, intermediateStops: [trip.intermediateStops[0], trip.intermediateStops[0], trip.intermediateStops[1]] })).toBeNull()
    expect(refreshJourneyLeg(j, 1, trip)).toBeNull()
  })
  it('keeps only the selected A-to-D slice of a longer trip', () => {
    const selected = transit('A', 'D', time(2), time(8))
    const j: Journey = { id: 'slice', duration: 360, startTime: time(2), endTime: time(8), transfers: 0, legs: [selected] }
    const full = { ...transit('X', 'Y', time(0), time(10)), tripId: selected.tripId, intermediateStops: ['A', 'B', 'C', 'D'].map((id, index) => ({ ...place(id), arrival: time(2 + index * 2), scheduledArrival: time(2 + index * 2), departure: time(2 + index * 2), scheduledDeparture: time(2 + index * 2) })) }
    const leg = refreshJourneyLeg(j, 0, full)?.legs[0] as TransitLeg
    expect([leg.from.name, ...(leg.intermediateStops ?? []).map(stop => stop.name), leg.to.name]).toEqual(['A', 'B', 'C', 'D'])
    expect(leg.legGeometry).toBe(selected.legGeometry)
  })
})
