import type { Departure, Place, TransitTrip } from './types'

export type DownstreamMatch = 'yes' | 'no' | 'unknown'
export interface DepartureFilters { line?: string; direction?: string; towardsStopId?: string }
export interface DepartureGroup {
  key: string
  directionKey: string
  headsign: string
  platform: string
  departures: Departure[]
}

/** Provider IDs are opaque; JSON encoding prevents collisions between components. */
export function directionKey(departure: Departure): string {
  return JSON.stringify([departure.routeId, departure.directionId, departure.headsign])
}

export function departureTime(departure: Departure): number {
  const value = departure.realTime ? departure.place.departure ?? departure.place.scheduledDeparture : departure.place.scheduledDeparture ?? departure.place.departure
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : Infinity
}

function matchesStop(place: Place, stopId: string): boolean {
  return place.stopId === stopId || place.parentId === stopId
}

/** A missing list is unknown, not proof that a destination is not served. */
export function downstreamMatch(departure: Departure, stopId: string, trip?: TransitTrip): DownstreamMatch {
  if (!stopId) return 'unknown'
  if (departure.nextStops !== undefined) {
    return departure.nextStops.some(stop => matchesStop(stop, stopId)) ? 'yes' : 'no'
  }
  if (!trip || trip.tripId !== departure.tripId || !departure.place.stopId || trip.intermediateStops === undefined) return 'unknown'
  const stops = [trip.from, ...(trip.intermediateStops ?? []), trip.to]
  let boardings = stops.flatMap((stop, index) => stop.stopId === departure.place.stopId ? [index] : [])
  // A repeated stop on a loop must be tied to the selected event, not the first occurrence.
  if (boardings.length > 1 && departure.place.scheduledDeparture) {
    const selectedTime = Date.parse(departure.place.scheduledDeparture)
    if (Number.isFinite(selectedTime)) {
      boardings = boardings.filter(index => {
        const value = stops[index].scheduledDeparture ?? (index === 0 ? trip.scheduledStartTime : undefined)
        return value !== undefined && Date.parse(value) === selectedTime
      })
    }
  }
  if (boardings.length !== 1) return 'unknown'
  return stops.slice(boardings[0] + 1).some(stop => matchesStop(stop, stopId)) ? 'yes' : 'no'
}

/** Unresolved events are returned separately so the caller can bound trip requests. */
export function filterDepartures(departures: readonly Departure[], filters: DepartureFilters, trips?: ReadonlyMap<string, TransitTrip>): { departures: Departure[]; unresolved: Departure[] } {
  const matched: Departure[] = []
  const unresolved: Departure[] = []
  for (const departure of departures) {
    if (filters.line && departure.routeShortName !== filters.line) continue
    if (filters.direction && directionKey(departure) !== filters.direction) continue
    if (filters.towardsStopId) {
      const result = downstreamMatch(departure, filters.towardsStopId, trips?.get(departure.tripId))
      if (result === 'unknown') { unresolved.push(departure); continue }
      if (result === 'no') continue
    }
    matched.push(departure)
  }
  const byTime = (a: Departure, b: Departure) => departureTime(a) - departureTime(b)
  matched.sort(byTime)
  unresolved.sort(byTime)
  return { departures: matched, unresolved }
}

/** Group by route, direction, headsign and boarding platform without merging branches. */
export function groupDepartures(departures: readonly Departure[]): DepartureGroup[] {
  const groups = new Map<string, DepartureGroup>()
  for (const departure of [...departures].sort((a, b) => departureTime(a) - departureTime(b))) {
    const direction = directionKey(departure)
    const platform = departure.place.track ?? departure.place.scheduledTrack ?? ''
    const key = JSON.stringify([direction, departure.place.stopId ?? '', platform])
    let group = groups.get(key)
    if (!group) {
      group = { key, directionKey: direction, headsign: departure.headsign, platform, departures: [] }
      groups.set(key, group)
    }
    group.departures.push(departure)
  }
  return [...groups.values()]
}
