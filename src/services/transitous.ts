import { GRAZ_CENTER, TRANSITOUS_API_BASE } from '../config'
import { isInGraz } from '../domain/geography'
import type { Coordinate, Departure, DeparturePage, DepartureQuery, Journey, JourneyPage, JourneyQuery, Leg, Locale, Place, PlaceChoice, PlaceKind, PlaceSearchMode, PlaceSearchResult, TransitTrip } from '../domain/types'

export type TransitousErrorKind = 'rate-limited' | 'network' | 'unavailable' | 'malformed' | 'out-of-area'

export class TransitousError extends Error {
  readonly kind: TransitousErrorKind
  readonly retryAfterMs?: number
  constructor(kind: TransitousErrorKind, retryAfterMs?: number) {
    super(kind)
    this.name = 'TransitousError'
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const timestamp = (value: unknown): value is string => text(value) && value.length > 0 && Number.isFinite(Date.parse(value))
const optional = (value: unknown, check: (value: unknown) => boolean) => value == null || check(value)
const coordinate = (value: RecordValue): boolean => finite(value.lat) && finite(value.lon) && Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180
const pickup = (value: unknown): boolean => value === 'NORMAL' || value === 'NOT_ALLOWED'
const mode = (value: unknown): boolean => value === 'BUS' || value === 'TRAM'
const nonnegative = (value: unknown): boolean => finite(value) && value >= 0

function validPlace(value: unknown): value is Place {
  if (!record(value) || !text(value.name) || !coordinate(value)) return false
  return ['stopId', 'parentId', 'track', 'scheduledTrack', 'stopCode'].every(key => optional(value[key], text)) &&
    ['arrival', 'departure', 'scheduledArrival', 'scheduledDeparture'].every(key => optional(value[key], timestamp)) &&
    optional(value.pickupType, pickup) && optional(value.dropoffType, pickup) && optional(value.cancelled, v => typeof v === 'boolean')
}

function validLeg(value: unknown): value is Leg {
  if (!record(value) || !(value.mode === 'WALK' || mode(value.mode)) ||
      !['startTime', 'endTime', 'scheduledStartTime', 'scheduledEndTime'].every(key => timestamp(value[key])) ||
      typeof value.realTime !== 'boolean' || typeof value.scheduled !== 'boolean' || !nonnegative(value.duration) ||
      !validPlace(value.from) || !validPlace(value.to) || !record(value.legGeometry) ||
      !text(value.legGeometry.points) || !Number.isInteger(value.legGeometry.precision) || !nonnegative(value.legGeometry.precision) ||
      !Number.isInteger(value.legGeometry.length) || !nonnegative(value.legGeometry.length) ||
      !optional(value.departureTimestampReason, text) || !optional(value.arrivalTimestampReason, text)) return false
  if (value.mode === 'WALK') {
    return optional(value.distance, nonnegative) && optional(value.steps, v => Array.isArray(v) && v.every(record))
  }
  return ['tripId', 'routeId', 'directionId', 'routeShortName', 'headsign'].every(key => text(value[key])) &&
    (value.tripId as string).length > 0 && optional(value.tripFrom, validPlace) && optional(value.tripTo, validPlace) &&
    optional(value.intermediateStops, v => Array.isArray(v) && v.every(validPlace)) &&
    optional(value.interlineWithPreviousLeg, v => typeof v === 'boolean') && optional(value.cancelled, v => typeof v === 'boolean') &&
    optional(value.displayName, text)
}

function validJourney(value: unknown): value is Journey {
  return record(value) && text(value.id) && value.id.length > 0 && nonnegative(value.duration) && timestamp(value.startTime) &&
    timestamp(value.endTime) && Number.isInteger(value.transfers) && nonnegative(value.transfers) &&
    Array.isArray(value.legs) && value.legs.length > 0 && value.legs.every(validLeg)
}

function validDeparture(value: unknown): value is Departure {
  return record(value) && validPlace(value.place) && mode(value.mode) && typeof value.realTime === 'boolean' &&
    ['headsign', 'tripId', 'routeId', 'directionId', 'routeShortName', 'displayName'].every(key => text(value[key])) &&
    (value.tripId as string).length > 0 && validPlace(value.tripFrom) && validPlace(value.tripTo) &&
    pickup(value.pickupDropoffType) && typeof value.cancelled === 'boolean' && typeof value.tripCancelled === 'boolean' &&
    optional(value.nextStops, v => Array.isArray(v) && v.every(validPlace)) &&
    (timestamp(value.place.departure) || timestamp(value.place.scheduledDeparture))
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

async function request(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    let response: Response
    try {
      response = await fetch(`${TRANSITOUS_API_BASE}${path}?${params}`, { signal: controller.signal, credentials: 'omit' })
    } catch (error) {
      if (signal.aborted) throw error
      throw new TransitousError('network')
    }
    if (response.status === 429) throw new TransitousError('rate-limited', retryAfter(response.headers.get('Retry-After')))
    if (!response.ok) throw new TransitousError('unavailable')
    try { return await response.json() } catch { throw new TransitousError('malformed') }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

// A shared request stays alive only while at least one caller still needs it.
const inflight = new Map<string, { controller: AbortController; promise: Promise<unknown>; users: number }>()
function sharedRequest(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(signal.reason)
  const key = `${path}?${params}`
  let entry = inflight.get(key)
  if (!entry) {
    const controller = new AbortController()
    const created = { controller, users: 0, promise: request(path, params, controller.signal) }
    entry = created
    inflight.set(key, created)
    void created.promise.then(
      () => { if (inflight.get(key) === created) inflight.delete(key) },
      () => { if (inflight.get(key) === created) inflight.delete(key) },
    )
  }
  const current = entry
  current.users++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', abort)
      current.users--
      if (current.users === 0 && inflight.get(key) === current) {
        inflight.delete(key)
        current.controller.abort()
      }
      return true
    }
    const abort = () => { if (finish()) reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    current.promise.then(
      value => { if (finish()) resolve(value) },
      error => { if (finish()) reject(error) },
    )
    if (signal.aborted) abort()
  })
}

type CacheEntry<T> = { value: T; expiresAt: number }
type PlaceSubtypeResult = { choices: PlaceChoice[]; outside: boolean }
const placesCache = new Map<string, CacheEntry<PlaceSubtypeResult>>()
const tripCache = new Map<string, CacheEntry<TransitTrip>>()
function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  cache.delete(key)
  if (entry.expiresAt <= Date.now()) return undefined
  cache.set(key, entry)
  return entry.value
}
function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number, limit: number): void {
  cache.delete(key)
  cache.set(key, { value, expiresAt: Date.now() + ttl })
  while (cache.size > limit) cache.delete(cache.keys().next().value!)
}

function ensureGraz(point: Coordinate): void {
  if (!finite(point.lat) || !finite(point.lon) || !isInGraz(point)) throw new TransitousError('out-of-area')
}

function cursors(value: RecordValue): Pick<JourneyPage, 'nextPageCursor' | 'previousPageCursor'> {
  if (!optional(value.nextPageCursor, text) || !optional(value.previousPageCursor, text)) throw new TransitousError('malformed')
  return {
    ...(text(value.nextPageCursor) && value.nextPageCursor ? { nextPageCursor: value.nextPageCursor } : {}),
    ...(text(value.previousPageCursor) && value.previousPageCursor ? { previousPageCursor: value.previousPageCursor } : {}),
  }
}

const normalizeSearch = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim()

async function searchSubtype(query: string, kind: PlaceKind, locale: Locale, signal: AbortSignal): Promise<PlaceSubtypeResult> {
  // Stop names often start with Graz; MOTIS matches partial input more reliably
  // with that prefix. Appending Graz to an unfinished address instead changes
  // the last autocomplete token and can suppress the intended street.
  const search = kind === 'STOP' && !/\bgraz\b/i.test(query) ? `Graz ${query}` : query
  const params = new URLSearchParams({
    text: search, type: kind, place: `${GRAZ_CENTER.lat},${GRAZ_CENTER.lon}`,
    min: '47.01099856381888,15.349171800035792', max: '47.135508816624096,15.535504642151956',
    numResults: '20', language: locale,
  })
  if (signal.aborted) throw signal.reason
  const key = params.toString()
  const saved = cached(placesCache, key)
  if (saved) return saved
  const data = await sharedRequest('/v1/geocode', params, signal)
  if (!Array.isArray(data)) throw new TransitousError('malformed')
  let outside = false
  const choices: PlaceChoice[] = []
  const ids = new Set<string>()
  const identities = new Map<string, string | undefined>()
  for (const item of data) {
    if (!record(item) || item.type !== kind || !text(item.name) || !item.name.trim() || !coordinate(item)) continue
    const id = text(item.id) && item.id ? item.id : undefined
    if (kind === 'STOP' && !id) continue
    const point = { lat: item.lat as number, lon: item.lon as number }
    if (!isInGraz(point)) { outside = true; continue }
    const identity = JSON.stringify([kind, item.name, point.lat, point.lon])
    if (id && ids.has(id)) continue
    if (identities.has(identity) && (kind !== 'STOP' || !id || identities.get(identity) === id)) continue
    if (id) ids.add(id)
    identities.set(identity, id)
    const street = text(item.street) && item.street.trim() ? item.street : undefined
    const houseNumber = text(item.houseNumber) && item.houseNumber.trim() ? item.houseNumber : undefined
    const context = [street, houseNumber, item.zip, item.city].filter(text).filter(Boolean).join(' ')
    choices.push({ kind, name: item.name, coordinate: point, ...(kind === 'STOP' && id ? { stopId: id } : {}), ...(context ? { subtitle: context } : {}), ...(street ? { street } : {}), ...(houseNumber ? { houseNumber } : {}) })
  }
  const result = { choices, outside }
  remember(placesCache, key, result, 600_000, 100)
  return result
}

export async function searchPlaces(textQuery: string, mode: PlaceSearchMode, locale: Locale, signal: AbortSignal): Promise<PlaceSearchResult> {
  if (signal.aborted) throw signal.reason
  const query = textQuery.trim()
  if (!query) return { choices: [], incomplete: false }
  const kinds: PlaceKind[] = mode === 'ALL' ? ['STOP', 'ADDRESS'] : [mode]
  const responses = await Promise.allSettled(kinds.map(kind => searchSubtype(query, kind, locale, signal)))
  if (signal.aborted) throw signal.reason
  const successes = responses.filter((result): result is PromiseFulfilledResult<PlaceSubtypeResult> => result.status === 'fulfilled')
  const failures = responses.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (!successes.length) {
    const rates = failures.map(result => result.reason).filter((error): error is TransitousError => error instanceof TransitousError && error.kind === 'rate-limited')
    if (rates.length) {
      const delays = rates.map(error => error.retryAfterMs).filter((delay): delay is number => delay !== undefined)
      throw new TransitousError('rate-limited', delays.length ? Math.max(...delays) : undefined)
    }
    throw failures[0].reason
  }
  const incomplete = failures.length > 0
  const all = successes.flatMap(result => result.value.choices)
  if (!incomplete && !all.length && successes.some(result => result.value.outside)) throw new TransitousError('out-of-area')
  const normalized = normalizeSearch(query).replace(/,\s*graz$/, '')
  const exactAddress: PlaceChoice[] = []
  const exactStop: PlaceChoice[] = []
  const stops: PlaceChoice[] = []
  const addresses: PlaceChoice[] = []
  for (const choice of all) {
    const address = choice.street && choice.houseNumber ? normalizeSearch(`${choice.street} ${choice.houseNumber}`) : ''
    if (choice.kind === 'ADDRESS' && address === normalized) exactAddress.push(choice)
    else if (choice.kind === 'STOP' && normalizeSearch(choice.name) === normalizeSearch(query)) exactStop.push(choice)
    else if (choice.kind === 'STOP') stops.push(choice)
    else addresses.push(choice)
  }
  const choices = [...exactAddress, ...exactStop]
  for (let index = 0; index < Math.max(stops.length, addresses.length); index++) {
    if (stops[index]) choices.push(stops[index])
    if (addresses[index]) choices.push(addresses[index])
  }
  return { choices, incomplete }
}

export async function planJourney(query: JourneyQuery, signal: AbortSignal): Promise<JourneyPage> {
  ensureGraz(query.origin.coordinate)
  ensureGraz(query.destination.coordinate)
  if (!finite(query.timeMs) || !finite(query.walkingSpeed) || query.walkingSpeed <= 0) throw new TransitousError('malformed')
  const place = (choice: PlaceChoice) => choice.kind === 'STOP' && choice.stopId ? choice.stopId : `${choice.coordinate.lat},${choice.coordinate.lon}`
  const params = new URLSearchParams({ fromPlace: place(query.origin), toPlace: place(query.destination), time: new Date(query.timeMs + 60_000).toISOString(), transitModes: 'BUS,TRAM', preTransitModes: 'WALK', postTransitModes: 'WALK', directModes: 'WALK', pedestrianSpeed: String(query.walkingSpeed), useRoutedTransfers: 'true', detailedTransfers: 'true', detailedLegs: 'true', additionalTransferTime: '1', transferTimeFactor: '1', joinInterlinedLegs: 'false', language: query.locale })
  if (query.pageCursor) params.set('pageCursor', query.pageCursor)
  const data = await sharedRequest('/v6/plan', params, signal)
  if (!record(data) || !Array.isArray(data.itineraries)) throw new TransitousError('malformed')
  const journeys: Journey[] = []
  let malformed = false
  for (const item of data.itineraries) {
    if (!record(item) || !Array.isArray(item.legs)) { malformed = true; continue }
    // Unsupported modes are out of scope, not evidence that the provider is broken.
    if (item.legs.some(leg => record(leg) && leg.mode !== 'WALK' && !mode(leg.mode))) continue
    if (!validJourney(item)) { malformed = true; continue }
    if (item.legs.some(leg => leg.mode !== 'WALK' && (!isInGraz({ lat: leg.from.lat, lon: leg.from.lon }) || !isInGraz({ lat: leg.to.lat, lon: leg.to.lon })))) continue
    journeys.push(item)
  }
  if (malformed && journeys.length === 0) throw new TransitousError('malformed')
  return { journeys, ...cursors(data) }
}

export async function getDepartures(query: DepartureQuery, signal: AbortSignal): Promise<DeparturePage> {
  if (!finite(query.timeMs)) throw new TransitousError('malformed')
  const params = new URLSearchParams({ time: new Date(query.timeMs).toISOString(), mode: 'BUS,TRAM', direction: 'LATER', n: '20', fetchStops: 'true', language: query.locale })
  if (query.stopId) params.set('stopId', query.stopId)
  else {
    if (!query.center || !finite(query.radius) || query.radius <= 0) throw new TransitousError('malformed')
    ensureGraz(query.center)
    params.set('center', `${query.center.lat},${query.center.lon}`)
    params.set('radius', String(query.radius))
    params.set('exactRadius', 'true')
  }
  if (query.pageCursor) params.set('pageCursor', query.pageCursor)
  const data = await sharedRequest('/v6/stoptimes', params, signal)
  if (!record(data) || !Array.isArray(data.stopTimes)) throw new TransitousError('malformed')
  const departures: Departure[] = []
  let malformed = false
  for (const item of data.stopTimes) {
    if (record(item) && !mode(item.mode)) continue
    if (!validDeparture(item)) { malformed = true; continue }
    if (isInGraz({ lat: item.place.lat, lon: item.place.lon })) departures.push(item)
  }
  if (malformed && departures.length === 0) throw new TransitousError('malformed')
  return { departures, ...cursors(data) }
}

export async function getTrip(tripId: string, locale: Locale, signal: AbortSignal): Promise<TransitTrip> {
  const params = new URLSearchParams({ tripId, language: locale, joinInterlinedLegs: 'false', detailedLegs: 'true' })
  if (signal.aborted) throw signal.reason
  const key = JSON.stringify([tripId, locale])
  // Only coalesce near-simultaneous consumers; scheduled refreshes fetch new predictions.
  const saved = cached(tripCache, key)
  if (saved) return saved
  const data = await sharedRequest('/v6/trip', params, signal)
  if (!validJourney(data)) throw new TransitousError('malformed')
  const leg = data.legs.find(candidate => candidate.mode !== 'WALK' && candidate.tripId === tripId)
  if (!leg || leg.mode === 'WALK') throw new TransitousError('malformed')
  remember(tripCache, key, leg, 1_000, 50)
  return leg
}
