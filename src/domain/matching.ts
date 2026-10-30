import polyline from '@mapbox/polyline'
import bearing from '@turf/bearing'
import distance from '@turf/distance'
import nearestPointOnLine from '@turf/nearest-point-on-line'
import { lineString, point } from '@turf/helpers'
import { positionStatus, type VehicleObservation } from '../services/opentrafficmap'
import { effectiveEventTime } from './connections'
import type { Place, TransitLeg, TransitTrip } from './types'

export type VehicleMatch =
  | { kind: 'likely'; vehicleId: string }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'none' }

type Position = [number, number]
type Projection = { along: number; distance: number; segment: number }
type TimedStop = { along: number; time: number }

function lineName(value: string): string {
  return value.normalize('NFKC').toLocaleUpperCase('de').replace(/\s+/g, '')
}

function targetName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('de')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^graz(?:\s+|$)/, '').trim()
}

function routeGeometry(trip: TransitTrip): Position[] | null {
  try {
    if (!trip.legGeometry?.points || !Number.isInteger(trip.legGeometry.precision)) return null
    const decoded = polyline.decode(trip.legGeometry.points, trip.legGeometry.precision)
    const coordinates: Position[] = decoded.map(([lat, lon]) => [lon, lat])
    return coordinates.length >= 2 && coordinates.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) ? coordinates : null
  } catch { return null }
}

function projections(coordinates: Position[], location: Position): Projection[] {
  const results: Projection[] = []
  let along = 0
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = coordinates[i], b = coordinates[i + 1]
    const length = distance(point(a), point(b), { units: 'meters' })
    if (length > 0) {
      const projected = nearestPointOnLine(lineString([a, b]), point(location), { units: 'meters' })
      results.push({ along: along + distance(point(a), projected, { units: 'meters' }), distance: projected.properties.dist, segment: i })
    }
    along += length
  }
  return results
}

function distinct(projections: Projection[]): Projection[] {
  const result: Projection[] = []
  for (const candidate of projections.sort((a, b) => a.distance - b.distance)) {
    if (!result.some(other => Math.abs(other.along - candidate.along) < 100)) result.push(candidate)
  }
  return result
}

function validTime(value: string | undefined): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function stopTime(stop: Place, trip: TransitTrip): number | null {
  return (trip.realTime ? validTime(stop.departure) ?? validTime(stop.arrival) : null)
    ?? validTime(stop.scheduledDeparture) ?? validTime(stop.scheduledArrival)
}

function timedStops(trip: TransitTrip, coordinates: Position[]): TimedStop[] | null {
  const stops = [trip.from, ...(trip.intermediateStops ?? []), trip.to]
  const result: TimedStop[] = []
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]
    const time = i === 0 ? effectiveEventTime(trip, 'departure').timeMs : i === stops.length - 1 ? effectiveEventTime(trip, 'arrival').timeMs : stopTime(stop, trip)
    if (time === null) continue
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return null
    const choices = projections(coordinates, [stop.lon, stop.lat]).filter(p => p.distance <= 100)
    if (!choices.length) return null
    const closest = Math.min(...choices.map(p => p.distance))
    const plausible = distinct(choices.filter(p => p.distance <= closest + 5))
    // A repeated stop on a loop cannot be assigned to a route occurrence safely.
    if (plausible.length !== 1) return null
    const along = plausible[0].along
    if (result.length && (along < result[result.length - 1].along || time < result[result.length - 1].time)) return null
    result.push({ along, time })
  }
  return result.length >= 2 ? result : null
}

function passageTime(along: number, stops: TimedStop[]): number | null {
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i]
    if (along >= a.along && along <= b.along && b.along > a.along) {
      return a.time + (b.time - a.time) * (along - a.along) / (b.along - a.along)
    }
  }
  return null
}

/** A likely match is evidence of compatibility, not a verified trip identity. */
export function matchVehicle(leg: TransitLeg, trip: TransitTrip, observations: readonly VehicleObservation[], nowMs: number): VehicleMatch {
  const route = lineName(leg.routeShortName)
  const targets = [trip.headsign, trip.tripTo?.name, trip.to.name].filter((v): v is string => !!v).map(targetName).filter(Boolean)
  if (!route || !targets.length) return { kind: 'none' }
  const geometry = routeGeometry(trip)
  const stops = geometry ? timedStops(trip, geometry) : null
  const likely: string[] = [], uncertain: string[] = []
  for (const vehicle of observations) {
    if (vehicle.mode !== leg.mode || positionStatus(vehicle.observedAt, nowMs) !== 'fresh' || !vehicle.lineDisplay || lineName(vehicle.lineDisplay) !== route || !vehicle.targetName || !targets.includes(targetName(vehicle.targetName))) continue
    if (!Number.isFinite(vehicle.coordinate.lat) || !Number.isFinite(vehicle.coordinate.lon)) continue
    if (!geometry || !stops) { uncertain.push(vehicle.id); continue }
    const near = distinct(projections(geometry, [vehicle.coordinate.lon, vehicle.coordinate.lat]).filter(p => p.distance <= 100))
    if (!near.length) continue
    let unknown = false
    const passing = near.filter(p => {
      const time = passageTime(p.along, stops)
      if (time === null) { unknown = true; return false }
      if (Math.abs(vehicle.observedAt - time) > 120_000) return false
      if (vehicle.heading !== undefined && vehicle.speed !== undefined && Number.isFinite(vehicle.heading) && Number.isFinite(vehicle.speed) && vehicle.speed >= 5) {
        const direction = bearing(point(geometry[p.segment]), point(geometry[p.segment + 1]))
        const difference = Math.abs(((vehicle.heading - direction + 540) % 360) - 180)
        if (difference > 60) return false
      }
      return true
    })
    if (passing.length > 1 || unknown) uncertain.push(vehicle.id)
    else if (passing.length === 1) likely.push(vehicle.id)
  }
  const candidates = [...new Set([...likely, ...uncertain])]
  if (candidates.length === 0) return { kind: 'none' }
  if (candidates.length === 1 && uncertain.length === 0) return { kind: 'likely', vehicleId: candidates[0] }
  return { kind: 'ambiguous', candidateIds: candidates }
}
