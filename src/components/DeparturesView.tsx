import { useEffect, useMemo, useRef, useState } from 'react'
import { directionKey, filterDepartures, groupDepartures, departureTime } from '../domain/departures'
import { formatTimeWithDay } from '../domain/formatting'
import { matchVehicle } from '../domain/matching'
import type { Coordinate, Departure, DepartureQuery, Journey, Locale, PlaceChoice, TransitTrip } from '../domain/types'
import { connectVehicles, positionStatus, type FeedStatus, type VehicleObservation } from '../services/opentrafficmap'
import { getDepartures, getTrip, searchPlaces, TransitousError } from '../services/transitous'
import { translate } from '../i18n'
import { useLocation } from '../state/location'
import { PlaceSearch } from './PlaceSearch'
import type { MapScene } from './TransitMap'
import './DeparturesView.css'

export interface DeparturesViewProps {
  locale: Locale
  onPlanFromStop: (origin: PlaceChoice) => void
  active?: boolean
  onMapSceneChange: (scene: MapScene) => void
  onFollowVehicle: (id: string) => void
}
const stopChoice = (d: Departure): PlaceChoice => ({ kind: 'STOP', name: d.place.name, stopId: d.place.stopId, coordinate: { lat: d.place.lat, lon: d.place.lon }, subtitle: d.place.track })
const key = (d: Departure) => `${d.tripId}|${d.place.stopId ?? ''}|${d.place.scheduledDeparture ?? d.place.departure ?? ''}`

export default function DeparturesView({ locale, onPlanFromStop, active = true, onMapSceneChange, onFollowVehicle }: DeparturesViewProps) {
  const de = locale === 'de'
  const { requestLocation, status: locationStatus } = useLocation()
  const [locationFailed, setLocationFailed] = useState(false)
  const [stop, setStop] = useState<PlaceChoice | null>(null)
  const [towards, setTowards] = useState<PlaceChoice | null>(null)
  const [nearby, setNearby] = useState<Coordinate | null>(null)
  const [query, setQuery] = useState<DepartureQuery | null>(null)
  const [departures, setDepartures] = useState<Departure[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [line, setLine] = useState('')
  const [direction, setDirection] = useState('')
  const [selected, setSelected] = useState<Departure | null>(null)
  const [trips, setTrips] = useState<ReadonlyMap<string, TransitTrip>>(new Map())
  const [resolveLimit, setResolveLimit] = useState(10)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const [lastGood, setLastGood] = useState(0)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(!document.hidden)
  const [now, setNow] = useState(Date.now())
  const [vehicles, setVehicles] = useState<readonly VehicleObservation[]>([])
  const [feed, setFeed] = useState<FeedStatus>({ state: 'connecting', nowMs: Date.now() })
  const feedAt = useRef(Date.now())
  const [pin, setPin] = useState<string | undefined>()
  const [failedTripId, setFailedTripId] = useState<string | null>(null)
  const boardRequest = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const queryRef = useRef(query)
  const selectedRef = useRef(selected); selectedRef.current = selected
  const obsNow = feed.nowMs + Math.max(0, now - feedAt.current)

  useEffect(() => { const onVisibility = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', onVisibility); return () => document.removeEventListener('visibilitychange', onVisibility) }, [])
  useEffect(() => {
    if (!locationFailed || locationStatus === 'locating') return
    setError(locationStatus === 'outside'
      ? (de ? 'Der Standort liegt außerhalb von Graz.' : 'The location is outside Graz.')
      : (de ? 'Standort nicht verfügbar oder Zugriff verweigert.' : 'Location unavailable or permission denied.'))
    setLocationFailed(false)
  }, [locationFailed, locationStatus, de])
  useEffect(() => { if (!visible || !active) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [visible, active])
  useEffect(() => {
    if (!visible || !active) { setVehicles([]); setFeed({ state: 'paused', nowMs: Date.now() }); return }
    return connectVehicles((items, status) => { feedAt.current = Date.now(); setVehicles(items); setFeed(status) })
  }, [visible, active])
  useEffect(() => () => { generation.current++; boardRequest.current?.abort() }, [])

  function message(err: unknown) {
    if (err instanceof TransitousError) {
      if (err.kind === 'rate-limited') { setRetryAt(Date.now() + (err.retryAfterMs ?? 0)); return de ? 'Zu viele Anfragen. Bitte später erneut versuchen.' : 'Too many requests. Please try again later.' }
      if (err.kind === 'out-of-area') return de ? 'Der Standort liegt außerhalb von Graz.' : 'The location is outside Graz.'
      if (err.kind === 'malformed') return de ? 'Die Antwort des Anbieters ist nicht verwendbar.' : 'The provider response is not usable.'
      if (err.kind === 'unavailable') return de ? 'Abfahrten sind derzeit nicht verfügbar.' : 'Departures are currently unavailable.'
    }
    return de ? 'Netzwerkfehler. Bitte erneut versuchen.' : 'Network error. Please try again.'
  }
  async function load(q: DepartureQuery, append = false) {
    boardRequest.current?.abort()
    const controller = new AbortController(); boardRequest.current = controller
    const current = ++generation.current
    setLoading(true); setError('')
    try {
      const page = await getDepartures(q, controller.signal)
      if (controller.signal.aborted || current !== generation.current) return
      if (!append) queryRef.current = { ...q, pageCursor: undefined }
      setDepartures(previous => append ? [...new Map([...previous, ...page.departures].map(item => [key(item), item])).values()] : page.departures)
      setCursor(page.nextPageCursor); setLastGood(Date.now()); setFailed(false)
    } catch (err) {
      if (!controller.signal.aborted && current === generation.current) { setError(message(err)); setFailed(true) }
    } finally { if (current === generation.current) setLoading(false) }
  }
  useEffect(() => { queryRef.current = query }, [query])
  useEffect(() => {
    if (!query || !visible || !active) return
    const detailController = new AbortController()
    if (Date.now() >= retryAt) void load({ ...query, timeMs: Date.now(), pageCursor: undefined })
    const timer = window.setInterval(() => {
      if (Date.now() < retryAt || !queryRef.current) return
      void load({ ...queryRef.current, timeMs: Date.now(), pageCursor: undefined })
      const departure = selectedRef.current
      if (departure) void getTrip(departure.tripId, locale, detailController.signal).then(trip => {
        if (!detailController.signal.aborted && selectedRef.current?.tripId === trip.tripId) { setTrips(old => new Map(old).set(trip.tripId, trip)); setFailedTripId(null) }
      }).catch(() => { if (!detailController.signal.aborted && selectedRef.current?.tripId === departure.tripId) { setFailedTripId(departure.tripId); setError(de ? 'Fahrtdetails konnten nicht aktualisiert werden.' : 'Trip details could not be refreshed.') } })
    }, 30000)
    return () => { clearInterval(timer); boardRequest.current?.abort(); detailController.abort() }
  }, [query, visible, active, retryAt])
  function chooseStop(choice: PlaceChoice | null) {
    setStop(choice); setNearby(null); setSelected(null); setPin(undefined); setLine(''); setDirection(''); setTrips(new Map()); setDepartures([]); setCursor(undefined)
    setQuery(choice?.stopId ? { stopId: choice.stopId, timeMs: Date.now(), locale } : null)
  }
  useEffect(() => { setQuery(previous => previous ? { ...previous, locale, pageCursor: undefined } : null) }, [locale])
  async function useNearby() {
    setLocationFailed(false)
    const fix = await requestLocation()
    if (!fix) { setLocationFailed(true); return }
    const point = fix.coordinate
    setError('')
    setStop(null); setNearby(point); setSelected(null); setPin(undefined); setDepartures([]); setLine(''); setDirection(''); setTrips(new Map()); setQuery({ center: point, radius: 500, timeMs: Date.now(), locale })
  }
  const nearbyStops = useMemo(() => [...new Map(departures.filter(d => d.place.stopId).map(d => [d.place.stopId!, stopChoice(d)])).values()], [departures])
  const board = nearby && !stop ? [] : departures
  const filters = { line: line || undefined, direction: direction || undefined, towardsStopId: towards?.stopId }
  const filtered = useMemo(() => filterDepartures(board, filters, trips), [board, line, direction, towards, trips])
  const groups = useMemo(() => groupDepartures(filtered.departures), [filtered.departures])
  useEffect(() => {
    if (!selected) return
    const result = filterDepartures([selected], filters, trips)
    if (!result.departures.length && !result.unresolved.length) {
      setSelected(null); setPin(undefined)
    }
  }, [selected, line, direction, towards, trips])
  const lines = [...new Set(board.map(d => d.routeShortName))].sort()
  const directions = [...new Map(board.filter(d => !line || d.routeShortName === line).map(d => [directionKey(d), d.headsign])).entries()]
  useEffect(() => {
    if (!visible || !active || !towards?.stopId) return
    const ids = [...new Set(filtered.unresolved.slice(0, resolveLimit).map(d => d.tripId))].filter(id => !trips.has(id))
    if (!ids.length) return
    const controller = new AbortController(); let index = 0
    const worker = async () => { while (index < ids.length && !controller.signal.aborted) { const id = ids[index++]; try { const trip = await getTrip(id, locale, controller.signal); if (!controller.signal.aborted) setTrips(old => new Map(old).set(id, trip)) } catch { /* unresolved remains explicit */ } } }
    void Promise.all([worker(), worker()]); return () => controller.abort()
  }, [visible, active, towards?.stopId, resolveLimit, departures, line, direction, locale])
  useEffect(() => {
    if (!selected || !visible || !active) return
    const controller = new AbortController()
    setFailedTripId(null)
    void getTrip(selected.tripId, locale, controller.signal).then(trip => { if (!controller.signal.aborted) setTrips(old => new Map(old).set(trip.tripId, trip)) }).catch(() => { if (!controller.signal.aborted) { setFailedTripId(selected.tripId); setError(de ? 'Fahrtdetails konnten nicht geladen werden.' : 'Trip details could not be loaded.') } })
    return () => controller.abort()
  }, [selected?.tripId, locale, visible, active])
  const trip = selected ? trips.get(selected.tripId) : undefined
  const match = trip ? matchVehicle(trip, trip, vehicles, obsNow) : { kind: 'none' as const }
  const candidateIds = match.kind === 'likely' ? [match.vehicleId] : match.kind === 'ambiguous' ? match.candidateIds : []
  const candidates = useMemo(() => feed.state === 'connected' ? vehicles.filter(v => candidateIds.includes(v.id) && positionStatus(v.observedAt, obsNow) === 'fresh') : [], [feed.state, vehicles, match.kind, candidateIds.join('|'), obsNow])
  useEffect(() => { if (pin && !candidates.some(v => v.id === pin)) setPin(undefined) }, [pin, candidates])
  const follow = !selected || failedTripId === selected.tripId ? undefined : pin && candidates.some(v => v.id === pin) ? pin : match.kind === 'likely' && candidates.some(v => v.id === match.vehicleId) ? match.vehicleId : undefined
  const liveStatus: MapScene['liveStatus'] = !selected ? 'idle' : feed.state === 'paused' || feed.state === 'disconnected' || failedTripId === selected.tripId ? 'unavailable' : feed.state === 'connecting' || !trip ? 'loading' : follow ? 'live' : match.kind === 'ambiguous' && candidates.length > 0 ? 'ambiguous' : 'unavailable'
  const vehicleSelection: MapScene['vehicleSelection'] = follow ? pin === follow ? 'pinned' : 'likely' : null
  const mapJourney = useMemo<Journey | null>(() => trip ? { id: trip.tripId, legs: [trip], startTime: trip.startTime, endTime: trip.endTime, duration: trip.duration, transfers: 0 } : null, [trip])
  useEffect(() => { if (active) onMapSceneChange({ journey: mapJourney, selectedLegIndex: null, vehicles: candidates.filter(v => v.id === follow), eligibleVehicleId: follow, liveStatus, vehicleSelection, observationNowMs: obsNow }) }, [active, onMapSceneChange, mapJourney, candidates, follow, liveStatus, vehicleSelection, obsNow])
  const selectDeparture = (item: Departure) => { setSelected(item); setPin(undefined) }

  return <div className="departures-layout"><section className="departures-pane">
    <h1>{de ? 'Abfahrten' : 'Departures'}</h1>
    <PlaceSearch label={de ? 'Haltestelle' : 'Stop'} locale={locale} value={stop} onChange={chooseStop} searchPlaces={searchPlaces} mode="STOP" />
    <button type="button" onClick={useNearby}>{de ? 'In der Nähe suchen' : 'Find nearby'}</button>
    {nearby && !stop && <div><h2>{de ? 'Haltestelle auswählen' : 'Select a stop'}</h2>{nearbyStops.map(choice => <button type="button" key={choice.stopId} onClick={() => chooseStop(choice)}>{choice.name}{choice.subtitle ? ` · ${choice.subtitle}` : ''}</button>)}{!loading && !nearbyStops.length && <p>{de ? 'Keine Haltestellen mit Abfahrten gefunden.' : 'No stops with departures found.'}</p>}</div>}
    {error && <p role="alert">{error} {query && <button type="button" disabled={now < retryAt || loading} onClick={() => void load({ ...query, timeMs: Date.now(), pageCursor: undefined })}>{de ? 'Erneut versuchen' : 'Retry'}</button>}</p>}
    {failed && lastGood > 0 && now - lastGood >= 60000 && <p role="status">{de ? 'Angezeigte Abfahrten sind möglicherweise veraltet.' : 'Displayed departures may be stale.'}</p>}
    {stop && <><details className="departure-filters"><summary>{de ? 'Filter' : 'Filters'}{(Number(!!line) + Number(!!direction) + Number(!!towards)) > 0 && ` · ${Number(!!line) + Number(!!direction) + Number(!!towards)}`}</summary><div className="departure-filters__content"><div className="departure-chips" role="group" aria-label={de ? 'Linie' : 'Line'}><button type="button" aria-pressed={!line} onClick={() => { setLine(''); setDirection('') }}>{de ? 'Alle Linien' : 'All lines'}</button>{lines.map(value => <button type="button" key={value} aria-pressed={line === value} onClick={() => { setLine(value); setDirection('') }}>{value}</button>)}</div><div className="departure-chips" role="group" aria-label={de ? 'Fahrtrichtung' : 'Direction'}><button type="button" aria-pressed={!direction} onClick={() => setDirection('')}>{de ? 'Alle Richtungen' : 'All directions'}</button>{directions.map(([id, label]) => <button type="button" key={id} aria-pressed={direction === id} onClick={() => setDirection(id)}>{label}</button>)}</div><PlaceSearch label={de ? 'Richtung Haltestelle (optional)' : 'Towards stop (optional)'} locale={locale} value={towards} onChange={value => { setTowards(value); setResolveLimit(10) }} searchPlaces={searchPlaces} mode="STOP" /></div></details>
      {loading && <p role="status">{de ? 'Abfahrten werden geladen …' : 'Loading departures…'}</p>}
      {!loading && !groups.length && <p>{de ? 'Keine passenden Abfahrten gefunden.' : 'No matching departures found.'}</p>}
      {groups.map(group => <section className="departure-group" key={group.key}><h2>{group.headsign} {group.platform && <small>· {group.platform}</small>}</h2>{group.departures.map(item => <button className="departure-row" type="button" key={key(item)} onClick={() => selectDeparture(item)} aria-pressed={selected && key(selected) === key(item) || false}><strong>{item.routeShortName}</strong><span>{item.headsign}<small>{item.cancelled || item.tripCancelled ? (de ? 'Entfällt' : 'Cancelled') : item.realTime && item.place.departure ? (de ? 'Prognose' : 'Predicted') : (de ? 'Fahrplan' : 'Scheduled')}</small></span><time>{formatTimeWithDay(departureTime(item), now, locale)}</time></button>)}</section>)}
      {filtered.unresolved.length > 0 && <p>{de ? 'Einige Fahrtrichtungen benötigen weitere Fahrtdetails.' : 'Some directions need additional trip details.'} <button type="button" onClick={() => setResolveLimit(n => n + 10)}>{de ? 'Weitere Abfahrten prüfen' : 'Check more departures'}</button></p>}
      {cursor && query && <button type="button" disabled={loading || now < retryAt} onClick={() => { if (queryRef.current) void load({ ...queryRef.current, pageCursor: cursor }, true) }}>{de ? 'Spätere Abfahrten' : 'Later departures'}</button>}
      <button type="button" onClick={() => onPlanFromStop(stop)}>{de ? 'Fahrt von hier planen' : 'Plan a journey from here'}</button></>}
    {selected && <section className="departure-detail"><h2>{selected.routeShortName} → {selected.headsign}</h2><p>{translate(locale, liveStatus === 'live' ? vehicleSelection === 'pinned' ? 'selectedObservation' : 'likelyVehicle' : liveStatus === 'loading' ? 'liveLoading' : liveStatus === 'ambiguous' ? 'liveAmbiguous' : 'liveUnavailable')}</p><details><summary>{de ? 'Live-Details' : 'Live details'}</summary>{candidates.map(v => <div key={v.id}>{v.lineDisplay} → {v.targetName} {v.vehicleNumber && `· ${v.vehicleNumber}`} · {Math.max(0, Math.floor((obsNow - v.observedAt) / 1000))} s <button type="button" aria-pressed={pin === v.id} onClick={() => setPin(pin === v.id ? undefined : v.id)}>{de ? 'Auswählen' : 'Select'}</button></div>)}</details>{follow && <button type="button" onClick={() => onFollowVehicle(follow)}>{translate(locale, 'followVehicle')}</button>}{trip ? <><h3>{de ? 'Haltestellen' : 'Stops'}</h3><ol>{[trip.from, ...(trip.intermediateStops ?? []), trip.to].map((place, index) => <li key={`${place.stopId ?? place.name}-${index}`}>{place.name}{place.track ? ` · ${place.track}` : ''}</li>)}</ol></> : <p>{de ? 'Fahrtdetails werden geladen …' : 'Loading trip details…'}</p>}</section>}
  </section></div>
}
