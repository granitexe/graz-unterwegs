import { describe, expect, it } from 'vitest'
import polyline from '@mapbox/polyline'
import { matchVehicle } from './matching'
import type { TransitTrip } from './types'
import type { VehicleObservation } from '../services/opentrafficmap'

const now = Date.parse('2026-10-30T10:05:00Z')
const time = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
const trip: TransitTrip = {
  mode: 'BUS', tripId: 'opaque', routeId: 'route', directionId: '0', routeShortName: '52Z', headsign: 'Eggenberg/UKH',
  startTime: time(-5), endTime: time(5), scheduledStartTime: time(-5), scheduledEndTime: time(5),
  realTime: false, scheduled: true, duration: 600,
  from: { name: 'Start', lat: 47.07, lon: 15.42 },
  to: { name: 'Eggenberg UKH', lat: 47.07, lon: 15.44 },
  legGeometry: { points: polyline.encode([[47.07, 15.42], [47.07, 15.43], [47.07, 15.44]], 6), precision: 6, length: 3 },
}
const observation: VehicleObservation = {
  id: 'vehicle', mode: 'BUS', coordinate: { lat: 47.07, lon: 15.43 }, observedAt: now,
  lineDisplay: '52 Z', targetName: 'Graz Eggenberg UKH', heading: 90, speed: 20,
}

describe('conservative vehicle matching', () => {
  it('identifies one compatible observation only as likely', () => {
    expect(matchVehicle(trip, trip, [observation], now)).toEqual({ kind: 'likely', vehicleId: 'vehicle' })
  })
  it('rejects wrong direction, mode, line suffix, empty target and stale positions', () => {
    const variants: VehicleObservation[] = [
      { ...observation, id: 'direction', targetName: 'Hauptbahnhof' },
      { ...observation, id: 'mode', mode: 'TRAM' },
      { ...observation, id: 'suffix', lineDisplay: '52' },
      { ...observation, id: 'empty', targetName: '' },
      { ...observation, id: 'stale', observedAt: now - 31_000 },
      { ...observation, id: 'future', observedAt: now + 6_000 },
      { ...observation, id: 'heading', heading: 270 },
    ]
    expect(matchVehicle(trip, trip, variants, now)).toEqual({ kind: 'none' })
  })
  it('rejects observations away from the route or inconsistent with passage time', () => {
    expect(matchVehicle(trip, trip, [{ ...observation, coordinate: { lat: 47.075, lon: 15.43 } }], now)).toEqual({ kind: 'none' })
    expect(matchVehicle(trip, { ...trip, startTime: time(-20), scheduledStartTime: time(-20), endTime: time(-10), scheduledEndTime: time(-10) }, [observation], now)).toEqual({ kind: 'none' })
  })
  it('does not choose between multiple plausible vehicles', () => {
    expect(matchVehicle(trip, trip, [observation, { ...observation, id: 'second' }], now)).toEqual({ kind: 'ambiguous', candidateIds: ['vehicle', 'second'] })
  })
  it('marks missing geometry or timing ambiguous rather than inventing a match', () => {
    const missingGeometry = { ...trip, legGeometry: { ...trip.legGeometry, points: '' } }
    expect(matchVehicle(trip, missingGeometry, [observation], now)).toEqual({ kind: 'ambiguous', candidateIds: ['vehicle'] })
    const missingTime = { ...trip, scheduledStartTime: '', scheduledEndTime: '' }
    expect(matchVehicle(trip, missingTime, [observation], now)).toEqual({ kind: 'ambiguous', candidateIds: ['vehicle'] })
  })
  it('does not resolve a repeated geometry occurrence on a loop', () => {
    const loop: TransitTrip = { ...trip, to: { ...trip.from, name: 'Eggenberg UKH' }, legGeometry: { points: polyline.encode([[47.07, 15.42], [47.07, 15.43], [47.07, 15.44], [47.07, 15.43], [47.07, 15.42]], 6), precision: 6, length: 5 } }
    expect(matchVehicle(trip, loop, [observation], now)).toEqual({ kind: 'ambiguous', candidateIds: ['vehicle'] })
  })
  it('does not infer a match without a target or route name', () => {
    expect(matchVehicle({ ...trip, routeShortName: '' }, trip, [observation], now)).toEqual({ kind: 'none' })
    expect(matchVehicle(trip, { ...trip, headsign: '', to: { ...trip.to, name: '' } }, [observation], now)).toEqual({ kind: 'none' })
  })
})
