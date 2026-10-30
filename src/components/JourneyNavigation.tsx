import { useEffect, useMemo, useRef, useState } from 'react'
import { effectiveEventTime, evaluateConnection, refreshJourneyLeg } from '../domain/connections'
import { formatDuration, formatTimeWithDay } from '../domain/formatting'
import { matchVehicle } from '../domain/matching'
import type { JourneyQuery, Locale, TransitTrip } from '../domain/types'
import { connectVehicles, positionStatus, type FeedStatus, type VehicleObservation } from '../services/opentrafficmap'
import { getTrip } from '../services/transitous'
import { translate } from '../i18n'
import type { JourneyAction, JourneyState } from '../state/journey'
import type { MapScene } from './TransitMap'
import { JourneyTimeline } from './JourneyTimeline'
import './JourneyNavigation.css'

interface Props {
  state: JourneyState
  onAction: (action: JourneyAction) => void
  query: JourneyQuery
  locale: Locale
  active?: boolean
  onBack: () => void
  onFindNewConnection: () => void
  onMapSceneChange: (scene: MapScene) => void
  onFollowVehicle: (vehicleId: string) => void
}

export default function JourneyNavigation({ state, onAction, query, locale, active = true, onBack, onFindNewConnection, onMapSceneChange, onFollowVehicle }: Props) {
  const journey = state.journey
  const de = locale === 'de'
  const [vehicles, setVehicles] = useState<readonly VehicleObservation[]>([])
  const [feed, setFeed] = useState<FeedStatus>({ state: 'connecting', nowMs: Date.now() })
  const [trips, setTrips] = useState<Record<string, TransitTrip>>({})
  const [uncertain, setUncertain] = useState<readonly number[]>([])
  const [failedAt, setFailedAt] = useState<number | null>(null)
  const [failedTrips, setFailedTrips] = useState<readonly string[]>([])
  const [now, setNow] = useState(Date.now())
  const [tabVisible, setTabVisible] = useState(!document.hidden)
  const visible = active && tabVisible
  const stateRef = useRef(state); stateRef.current = state
  const onActionRef = useRef(onAction); onActionRef.current = onAction
  const feedReceivedAt = useRef(Date.now())
  const evaluation = useMemo(() => journey ? evaluateConnection(journey, now) : null, [journey, now])
  const inspected = journey && state.selectedLegIndex !== null ? journey.legs[state.selectedLegIndex] : undefined
  const displayedIndex = journey ? (inspected && inspected.mode !== 'WALK' ? state.selectedLegIndex! : journey.legs.findIndex((leg, index) => index > (state.selectedLegIndex ?? -1) && leg.mode !== 'WALK' && (effectiveEventTime(leg, 'arrival').timeMs ?? Infinity) >= now)) : -1
  const displayed = journey && displayedIndex >= 0 ? journey.legs[displayedIndex] : undefined
  const transit = displayed && displayed.mode !== 'WALK' ? displayed : undefined
  const nextIndex = journey && displayedIndex >= 0 ? journey.legs.findIndex((leg, index) => index > displayedIndex && leg.mode !== 'WALK' && (effectiveEventTime(leg, 'arrival').timeMs ?? Infinity) >= now) : -1

  useEffect(() => { const update = () => setTabVisible(!document.hidden); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update) }, [])
  useEffect(() => { if (!visible) return; setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [visible])
  useEffect(() => {
    if (!visible) { setVehicles([]); setFeed({ state: 'paused', nowMs: Date.now() }); return }
    return connectVehicles((observations, status) => { feedReceivedAt.current = Date.now(); setVehicles(observations); setFeed(status) })
  }, [visible])
  const observationNow = feed.nowMs + Math.max(0, now - feedReceivedAt.current)

  useEffect(() => { setTrips({}); setUncertain([]); setFailedAt(null); setFailedTrips([]) }, [journey?.id])
  // A single visible-view scheduler, with at most two concurrent requests.
  useEffect(() => {
    if (!visible || !journey) return
    const controller = new AbortController()
    let timer: number | undefined
    let cycle = 0
    const routeId = journey.id
    const selectedIndex = state.selectedLegIndex
    const refresh = async () => {
      const snapshot = stateRef.current
      const current = snapshot.journey
      if (!current || current.id !== routeId || snapshot.selectedLegIndex !== selectedIndex) return
      const time = Date.now()
      const first = selectedIndex ?? current.legs.findIndex(leg => leg.mode !== 'WALK' && (effectiveEventTime(leg, 'arrival').timeMs ?? Infinity) >= time)
      const next = current.legs.findIndex((leg, index) => index > first && leg.mode !== 'WALK' && (effectiveEventTime(leg, 'arrival').timeMs ?? Infinity) >= time)
      const wanted = current.legs.flatMap((leg, index) => {
        if (leg.mode === 'WALK') return []
        const notEnded = (effectiveEventTime(leg, 'arrival').timeMs ?? Infinity) >= time
        const explicitlySelected = selectedIndex === index
        if (!notEnded && (!explicitlySelected || cycle > 0)) return []
        return cycle % 2 === 0 || index === first || index === next ? [index] : []
      })
      cycle++
      const ids = [...new Set(wanted.map(index => { const leg = current.legs[index]; return leg.mode === 'WALK' ? '' : leg.tripId }).filter(Boolean))]
      const fetched: Record<string, TransitTrip> = {}; const failures: string[] = []; let cursor = 0
      const worker = async () => { while (cursor < ids.length && !controller.signal.aborted) { const id = ids[cursor++]; try { fetched[id] = await getTrip(id, locale, controller.signal) } catch { failures.push(id) } } }
      await Promise.all([worker(), worker()])
      if (controller.signal.aborted) return
      const latest = stateRef.current
      if (!latest.journey || latest.journey.id !== routeId || latest.selectedLegIndex !== selectedIndex) return
      setTrips(previous => ({ ...previous, ...fetched }))
      setFailedAt(previous => failures.length ? previous ?? Date.now() : null)
      setFailedTrips(previous => [...previous.filter(id => !ids.includes(id)), ...failures])
      let refreshed = latest.journey
      const missing: number[] = []
      for (const index of wanted) {
        const leg = refreshed.legs[index]
        if (!leg || leg.mode === 'WALK' || !fetched[leg.tripId]) continue
        const result = refreshJourneyLeg(refreshed, index, fetched[leg.tripId])
        if (result) refreshed = result
        else missing.push(index)
      }
      setUncertain(previous => [...new Set([...previous.filter(index => !wanted.includes(index) || !fetched[(current.legs[index] as TransitTrip).tripId]), ...missing])])
      if (refreshed !== latest.journey) onActionRef.current({ type: 'refresh', journey: refreshed })
      if (!controller.signal.aborted) timer = window.setTimeout(refresh, 30000)
    }
    void refresh()
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer) }
  }, [visible, locale, journey?.id, state.selectedLegIndex])

  const transfer = evaluation?.transfers.find(item => item.toLegIndex === displayedIndex)
  const match = transit && !transit.cancelled && transfer?.status !== 'unreachable' && trips[transit.tripId] ? matchVehicle(transit, trips[transit.tripId], vehicles, observationNow) : { kind: 'none' as const }
  const candidateIds = match.kind === 'likely' ? [match.vehicleId] : match.kind === 'ambiguous' ? match.candidateIds : []
  const eligibleIds = feed.state === 'connected' && transit && !failedTrips.includes(transit.tripId) ? candidateIds.filter(id => vehicles.some(vehicle => vehicle.id === id && Number.isFinite(vehicle.coordinate.lat) && Number.isFinite(vehicle.coordinate.lon) && positionStatus(vehicle.observedAt, observationNow) === 'fresh')) : []
  const pinned = state.pinnedVehicleId && eligibleIds.includes(state.pinnedVehicleId) ? state.pinnedVehicleId : null
  const chosen = pinned ?? (match.kind === 'likely' && eligibleIds.includes(match.vehicleId) ? match.vehicleId : null)
  const nextLeg = journey && nextIndex >= 0 ? journey.legs[nextIndex] : undefined
  const nextTransfer = evaluation?.transfers.find(item => item.toLegIndex === nextIndex)
  const nextMatch = nextLeg && nextLeg.mode !== 'WALK' && !nextLeg.cancelled && nextTransfer?.status !== 'unreachable' && trips[nextLeg.tripId] ? matchVehicle(nextLeg, trips[nextLeg.tripId], vehicles, observationNow) : null
  const nextId = nextMatch?.kind === 'likely' ? nextMatch.vehicleId : null
  const shown = useMemo(() => vehicles.filter(vehicle => (vehicle.id === chosen || vehicle.id === nextId) && positionStatus(vehicle.observedAt, observationNow) !== 'missing'), [vehicles, chosen, nextId, observationNow])
  useEffect(() => { if (state.pinnedVehicleId && !pinned) onAction({ type: 'expire-pin' }) }, [state.pinnedVehicleId, pinned, onAction])
  const liveStatus: MapScene['liveStatus'] = !transit ? 'idle' : feed.state === 'paused' || feed.state === 'disconnected' || failedTrips.includes(transit.tripId) ? 'unavailable' : feed.state === 'connecting' || !trips[transit.tripId] ? 'loading' : chosen ? 'live' : match.kind === 'ambiguous' && eligibleIds.length > 0 ? 'ambiguous' : 'unavailable'
  const vehicleSelection: MapScene['vehicleSelection'] = chosen ? pinned ? 'pinned' : 'likely' : null
  const scene = useMemo<MapScene>(() => ({ journey, selectedLegIndex: state.selectedLegIndex, origin: query.origin, destination: query.destination, vehicles: shown, eligibleVehicleId: chosen ?? undefined, liveStatus, vehicleSelection, observationNowMs: observationNow }), [journey, state.selectedLegIndex, query.origin, query.destination, shown, chosen, liveStatus, vehicleSelection, observationNow])
  useEffect(() => { if (active) onMapSceneChange(scene) }, [active, scene, onMapSceneChange])

  if (!journey || !evaluation) return null
  const warning = evaluation.status === 'unreachable' || evaluation.reason === 'platform-changed' || evaluation.transfers.some(item => item.reason === 'platform-changed' || item.status === 'unreachable')
  const stale = failedAt !== null && now - failedAt >= 60000
  const lastLeg = journey.legs[journey.legs.length - 1]
  const endTime = lastLeg ? effectiveEventTime(lastLeg, 'arrival').timeMs : null
  return <section className="journey-navigation" aria-label={de ? 'Gewählte Verbindung' : 'Selected connection'}>
    <header className="journey-navigation__header"><button type="button" onClick={onBack}>{de ? '← Ergebnisse' : '← Results'}</button><h2>{de ? 'Gewählte Verbindung' : 'Selected connection'}</h2></header>
    <div className="journey-summary"><strong>{endTime !== null ? formatTimeWithDay(endTime, Date.parse(journey.startTime), locale) : '—'}</strong><span>{formatDuration(journey.duration, locale)}</span><div>{query.origin.name} → {query.destination.name}</div></div>
    <div className="journey-actions" aria-label={de ? 'Abschnitt auswählen' : 'Inspect a segment'}>
      <button type="button" aria-pressed={state.selectedLegIndex === null} onClick={() => onAction({ type: 'select-leg', index: null })}>{de ? 'Gesamte Route' : 'Whole route'}</button>
      {journey.legs.map((leg, index) => <button type="button" key={index} aria-pressed={state.selectedLegIndex === index} onClick={() => onAction({ type: 'select-leg', index })}>{leg.mode === 'WALK' ? (de ? 'Zu Fuß' : 'Walk') : `${leg.mode === 'TRAM' ? 'Tram' : 'Bus'} ${leg.routeShortName}`}</button>)}
    </div>
    {state.selectedLegIndex === null && displayedIndex < 0 && <p>{de ? 'Geplante Fahrt beendet' : 'Scheduled journey has ended'}</p>}
    {warning && <div className="journey-notice" role="status"><span>{evaluation.reason === 'cancelled' ? (de ? 'Fahrt fällt aus.' : 'Service cancelled.') : evaluation.reason === 'platform-changed' || evaluation.transfers.some(item => item.reason === 'platform-changed') ? (de ? 'Bahnsteig geändert; Umstieg prüfen.' : 'Platform changed; check the transfer.') : (de ? 'Umstieg laut Fahrplan nicht möglich.' : 'Transfer does not fit the timetable.')}</span><button type="button" onClick={onFindNewConnection}>{de ? 'Neue Verbindung suchen' : 'Find new connection'}</button></div>}
    {uncertain.length > 0 && <p className="journey-notice">{de ? 'Details für einen Abschnitt sind ungewiss.' : 'Details for a segment are uncertain.'}</p>}
    {stale && <p className="journey-notice">{de ? 'Letzte Fahrtdaten veraltet; Aktualisierung fehlgeschlagen.' : 'Last trip details are stale; refresh failed.'}</p>}
    <JourneyTimeline journey={journey} locale={locale} activeLegIndex={state.selectedLegIndex} evaluation={evaluation} onSelectLeg={index => onAction({ type: 'select-leg', index })} originName={query.origin.name} destinationName={query.destination.name} unavailableStopLegIndices={journey.legs.flatMap((leg, index) => leg.mode !== 'WALK' && (uncertain.includes(index) || failedTrips.includes(leg.tripId)) ? [index] : [])} />
    {liveStatus !== 'idle' && <p>{transit && `${transit.routeShortName} → ${transit.headsign} · `}{translate(locale, liveStatus === 'live' ? vehicleSelection === 'pinned' ? 'selectedObservation' : 'likelyVehicle' : liveStatus === 'loading' ? 'liveLoading' : liveStatus === 'ambiguous' ? 'liveAmbiguous' : 'liveUnavailable')}</p>}
    {chosen && <button type="button" onClick={() => onFollowVehicle(chosen)}>{de ? 'Fahrzeug folgen' : 'Follow vehicle'}</button>}
    <details className="journey-live"><summary>{de ? 'Live-Details' : 'Live details'}</summary>
      <p>{de ? 'Fahrzeugpositionen sind Beobachtungen, keine bestätigte Fahrtzuordnung.' : 'Vehicle positions are observations, not confirmed trip identities.'}</p>
      {match.kind === 'ambiguous' && <ul>{candidateIds.map(id => { const vehicle = vehicles.find(item => item.id === id); if (!vehicle) return null; return <li key={id}><button type="button" disabled={!eligibleIds.includes(id)} aria-pressed={pinned === id} onClick={() => onAction({ type: 'pin', vehicleId: pinned === id ? null : id })}>{vehicle.lineDisplay} · {vehicle.vehicleNumber ?? id} · {vehicle.targetName} · {Math.max(0, Math.floor((observationNow - vehicle.observedAt) / 1000))}s</button></li> })}</ul>}
    </details>
  </section>
}
