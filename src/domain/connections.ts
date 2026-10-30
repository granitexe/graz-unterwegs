import type { Journey, Leg, Place, TransitLeg, TransitTrip } from './types'

export type TimeProvenance = 'predicted' | 'scheduled'
export interface EffectiveEvent { timeMs: number | null; provenance: TimeProvenance }
export type ConnectionStatus = 'feasible' | 'tight' | 'unreachable' | 'unknown'
export type ConnectionReason = 'cancelled' | 'pickup-not-allowed' | 'dropoff-not-allowed' | 'missed' | 'missing-time' | 'missing-transfer' | 'platform-changed' | 'arrival-unconfirmed' | 'invalid-duration'
export interface TransferEvaluation {
  fromLegIndex: number
  toLegIndex: number
  readyAt: number | null
  departureAt: number | null
  requiredTransferSeconds: number | null
  slackSeconds: number | null
  status: ConnectionStatus
  reason?: ConnectionReason
  provenance: TimeProvenance
  interlined: boolean
}
export interface ConnectionEvaluation {
  status: ConnectionStatus
  transfers: TransferEvaluation[]
  events: { legIndex: number; departure: EffectiveEvent; arrival: EffectiveEvent }[]
  reason?: ConnectionReason
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** A provider prediction is not a measured vehicle arrival. */
export function effectiveEventTime(leg: Leg, event: 'departure' | 'arrival'): EffectiveEvent {
  const reason = event === 'departure' ? (leg.from.departureTimestampReason ?? leg.departureTimestampReason) : (leg.to.arrivalTimestampReason ?? leg.arrivalTimestampReason)
  const actual = timestamp(event === 'departure' ? leg.startTime : leg.endTime)
  const scheduled = timestamp(event === 'departure' ? leg.scheduledStartTime : leg.scheduledEndTime)
  const predicted = reason !== 'NO_RT_DATA' && (reason === 'PREDICTED' || reason === 'PROPAGATED' || (reason == null && leg.realTime))
  if (predicted && actual !== null) return { timeMs: actual, provenance: 'predicted' }
  return { timeMs: scheduled, provenance: 'scheduled' }
}

function changedPlatform(place: Place): boolean {
  return !!place.track && !!place.scheduledTrack && place.track !== place.scheduledTrack
}
function samePlatform(a: Place, b: Place): boolean {
  if (!a.stopId || !b.stopId || a.stopId !== b.stopId) return false
  const aTrack = a.track ?? a.scheduledTrack
  const bTrack = b.track ?? b.scheduledTrack
  return !aTrack || !bTrack || aTrack === bTrack
}
function legProblem(leg: TransitLeg, staysOnboard = false): ConnectionReason | undefined {
  if (leg.cancelled || leg.from.cancelled || leg.to.cancelled) return 'cancelled'
  if (leg.from.pickupType === 'NOT_ALLOWED' && !leg.interlineWithPreviousLeg) return 'pickup-not-allowed'
  if (!staysOnboard && leg.to.dropoffType === 'NOT_ALLOWED') return 'dropoff-not-allowed'
  return undefined
}
function severity(status: ConnectionStatus): number {
  return { feasible: 0, tight: 1, unknown: 2, unreachable: 3 }[status]
}

/** Evaluates every transfer; provider walk durations already include the transfer margin. */
export function evaluateConnection(journey: Journey, nowMs: number): ConnectionEvaluation {
  const transit = journey.legs.flatMap((leg, index) => leg.mode === 'WALK' ? [] : [{ leg, index }])
  const events = transit.map(({ leg, index }) => ({ legIndex: index, departure: effectiveEventTime(leg, 'departure'), arrival: effectiveEventTime(leg, 'arrival') }))
  const transfers: TransferEvaluation[] = []
  let status: ConnectionStatus = 'feasible'
  let reason: ConnectionReason | undefined
  const apply = (next: ConnectionStatus, why?: ConnectionReason) => {
    if (severity(next) > severity(status)) { status = next; reason = why }
  }
  for (const [index, { leg }] of transit.entries()) {
    const arrival = effectiveEventTime(leg, 'arrival')
    if (arrival.timeMs !== null && arrival.timeMs < nowMs) continue
    const problem = legProblem(leg, transit[index + 1]?.leg.interlineWithPreviousLeg === true)
    if (problem) apply('unreachable', problem)
    if (effectiveEventTime(leg, 'departure').timeMs === null || arrival.timeMs === null) apply('unknown', 'missing-time')
  }
  for (let i = 1; i < transit.length; i++) {
    const previous = transit[i - 1]
    const next = transit[i]
    const arrival = effectiveEventTime(previous.leg, 'arrival')
    const departure = effectiveEventTime(next.leg, 'departure')
    const interlined = next.leg.interlineWithPreviousLeg === true
    const walks = journey.legs.slice(previous.index + 1, next.index)
    const invalidWalk = walks.some(leg => leg.mode !== 'WALK' || !Number.isFinite(leg.duration) || leg.duration < 0)
    let required: number | null = interlined ? 0 : walks.reduce((total, leg) => total + leg.duration, 0)
    let transferStatus: ConnectionStatus = 'feasible'
    let transferReason: ConnectionReason | undefined
    if (!interlined && invalidWalk) { required = null; transferStatus = 'unknown'; transferReason = 'invalid-duration' }
    else if (!interlined && (changedPlatform(previous.leg.to) || changedPlatform(next.leg.from))) { transferStatus = 'unknown'; transferReason = 'platform-changed' }
    else if (!interlined && walks.length === 0) {
      if (!samePlatform(previous.leg.to, next.leg.from)) { required = null; transferStatus = 'unknown'; transferReason = 'missing-transfer' }
      else {
        // The accepted scheduled interval is the only available conservative minimum.
        const scheduledArrival = timestamp(previous.leg.scheduledEndTime)
        const scheduledDeparture = timestamp(next.leg.scheduledStartTime)
        required = scheduledArrival !== null && scheduledDeparture !== null && scheduledDeparture >= scheduledArrival ? (scheduledDeparture - scheduledArrival) / 1000 : null
        if (required === null) { transferStatus = 'unknown'; transferReason = 'missing-transfer' }
      }
    }
    const readyAt = arrival.timeMs !== null && required !== null ? arrival.timeMs + required * 1000 : null
    const slackSeconds = readyAt !== null && departure.timeMs !== null ? (departure.timeMs - readyAt) / 1000 : null
    const problem = legProblem(next.leg, transit[i + 1]?.leg.interlineWithPreviousLeg === true) ?? (arrival.timeMs !== null && arrival.timeMs < nowMs ? undefined : legProblem(previous.leg, interlined))
    if (problem) { transferStatus = 'unreachable'; transferReason = problem }
    else if (readyAt === null || departure.timeMs === null) { if (transferStatus === 'feasible') { transferStatus = 'unknown'; transferReason = 'missing-time' } }
    else if (!interlined && arrival.timeMs !== null && arrival.timeMs < nowMs && departure.timeMs >= nowMs) {
      if (transferStatus === 'feasible') { transferStatus = 'unknown'; transferReason = 'arrival-unconfirmed' }
    } else if (transferStatus === 'feasible' && slackSeconds !== null && slackSeconds < 0) { transferStatus = 'unreachable'; transferReason = 'missed' }
    else if (transferStatus === 'feasible' && !interlined && slackSeconds !== null && slackSeconds < 120) transferStatus = 'tight'
    const provenance: TimeProvenance = arrival.provenance === 'predicted' && departure.provenance === 'predicted' ? 'predicted' : 'scheduled'
    transfers.push({ fromLegIndex: previous.index, toLegIndex: next.index, readyAt, departureAt: departure.timeMs, requiredTransferSeconds: required, slackSeconds, status: transferStatus, reason: transferReason, provenance, interlined })
    if (departure.timeMs === null || departure.timeMs >= nowMs) apply(transferStatus, transferReason)
  }
  return { status, transfers, events, reason }
}

/** Refresh the selected stop slice of the same trip without changing its routed geometry. */
export function refreshJourneyLeg(journey: Journey, legIndex: number, trip: TransitTrip): Journey | null {
  const selected = journey.legs[legIndex]
  if (!selected || selected.mode === 'WALK' || !selected.from.stopId || !selected.to.stopId) return null
  if (trip.mode !== selected.mode || trip.tripId !== selected.tripId) return null
  const stops = [trip.from, ...(trip.intermediateStops ?? []), trip.to]
  const pairs: [number, number][] = []
  stops.forEach((stop, i) => {
    if (stop.stopId === selected.from.stopId) stops.forEach((end, j) => { if (j > i && end.stopId === selected.to.stopId) pairs.push([i, j]) })
  })
  if (pairs.length !== 1) return null
  const [start, end] = pairs[0]
  const from = stops[start]
  const to = stops[end]
  const startTime = from.departure ?? (start === 0 ? trip.startTime : undefined)
  const scheduledStartTime = from.scheduledDeparture ?? (start === 0 ? trip.scheduledStartTime : undefined)
  const endTime = to.arrival ?? (end === stops.length - 1 ? trip.endTime : undefined)
  const scheduledEndTime = to.scheduledArrival ?? (end === stops.length - 1 ? trip.scheduledEndTime : undefined)
  if (!startTime || !scheduledStartTime || !endTime || !scheduledEndTime) return null
  const startMs = timestamp(startTime)
  const endMs = timestamp(endTime)
  if (startMs === null || endMs === null || endMs < startMs) return null
  const replacement: TransitLeg = { ...selected, from: { ...selected.from, ...from }, to: { ...selected.to, ...to }, startTime, scheduledStartTime, endTime, scheduledEndTime, duration: (endMs - startMs) / 1000, realTime: trip.realTime, scheduled: trip.scheduled, cancelled: trip.cancelled, departureTimestampReason: from.departureTimestampReason ?? trip.departureTimestampReason, arrivalTimestampReason: to.arrivalTimestampReason ?? trip.arrivalTimestampReason, intermediateStops: stops.slice(start + 1, end) }
  const legs = journey.legs.slice()
  legs[legIndex] = replacement
  return { ...journey, legs }
}
