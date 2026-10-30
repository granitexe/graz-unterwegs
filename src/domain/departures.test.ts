import { describe, expect, it } from 'vitest'
import { departureTime, directionKey, downstreamMatch, filterDepartures, groupDepartures } from './departures'
import type { Departure, Place, TransitTrip } from './types'

const stop = (stopId: string, scheduledDeparture?: string): Place => ({ name: stopId, stopId, lat: 47.07, lon: 15.44, scheduledDeparture })
const time = (minute: string) => `2026-10-30T10:${minute}:00Z`
function departure(overrides: Partial<Departure> = {}): Departure {
  return { place: stop('board', time('10')), mode: 'BUS', realTime: false, headsign: 'East', tripFrom: stop('origin'), tripTo: stop('end'), tripId: 'trip', routeId: 'route', directionId: '0', routeShortName: '63', displayName: '63', pickupDropoffType: 'NORMAL', cancelled: false, tripCancelled: false, ...overrides }
}
function trip(stops: Place[]): TransitTrip {
  return { mode: 'BUS', tripId: 'trip', routeId: 'route', directionId: '0', routeShortName: '63', headsign: 'East', from: stops[0], to: stops[stops.length - 1], intermediateStops: stops.slice(1, -1), startTime: time('00'), endTime: time('30'), scheduledStartTime: time('00'), scheduledEndTime: time('30'), realTime: false, scheduled: true, duration: 1800, legGeometry: { points: '', precision: 6, length: 0 } }
}

describe('departure directions and downstream stops', () => {
  it('keeps opposite directions and short turns separate, including platforms', () => {
    const first = departure({ nextStops: [stop('target')] })
    const opposite = departure({ directionId: '1', headsign: 'West', nextStops: [stop('other')] })
    const short = departure({ headsign: 'Short turn', nextStops: [] })
    const platform = departure({ place: { ...first.place, track: 'B' } })
    expect(new Set([first, opposite, short].map(directionKey)).size).toBe(3)
    expect(groupDepartures([first, opposite, short, platform])).toHaveLength(4)
    expect(filterDepartures([first, opposite, short], { direction: directionKey(first) }).departures).toEqual([first])
  })

  it('includes different lines serving the same downstream stop, not similar headsigns', () => {
    const a = departure({ nextStops: [stop('target')] })
    const b = departure({ tripId: 'other', routeId: 'other', routeShortName: '1', headsign: 'Different', nextStops: [{ ...stop('platform'), parentId: 'target' }] })
    const wrong = departure({ tripId: 'wrong', nextStops: [stop('elsewhere')] })
    expect(filterDepartures([a, b, wrong], { towardsStopId: 'target' }).departures).toEqual([a, b])
  })

  it('resolves missing nextStops by ordered trip stops, never an earlier stop', () => {
    const d = departure()
    const full = trip([stop('earlier'), stop('board', time('10')), stop('later')])
    expect(downstreamMatch(d, 'earlier', full)).toBe('no')
    expect(downstreamMatch(d, 'later', full)).toBe('yes')
    expect(downstreamMatch(d, 'later')).toBe('unknown')
    expect(filterDepartures([d], { towardsStopId: 'later' }).unresolved).toEqual([d])
    expect(filterDepartures([d], { towardsStopId: 'later' }, new Map([['trip', full]])).departures).toEqual([d])
  })

  it('disambiguates loop boarding by scheduled event and refuses ambiguous loops', () => {
    const full = trip([stop('board', time('05')), stop('target'), stop('board', time('10')), stop('end')])
    expect(downstreamMatch(departure(), 'target', full)).toBe('no')
    expect(downstreamMatch(departure({ place: stop('board') }), 'target', full)).toBe('unknown')
    expect(downstreamMatch(departure(), 'target', { ...full, intermediateStops: undefined })).toBe('unknown')
  })

  it('sorts by effective departure and respects scheduled-only data', () => {
    const later = departure({ place: { ...stop('board', time('20')), departure: time('01') } })
    const predicted = departure({ realTime: true, place: { ...stop('board', time('30')), departure: time('05') } })
    expect(departureTime(later)).toBe(Date.parse(time('20')))
    expect(filterDepartures([later, predicted], {}).departures).toEqual([predicted, later])
    expect(groupDepartures([later, predicted])[0].departures).toEqual([predicted, later])
  })
})
