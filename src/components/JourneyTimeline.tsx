import { effectiveEventTime, type ConnectionEvaluation } from '../domain/connections'
import { formatDuration, formatTimeWithDay } from '../domain/formatting'
import { translate } from '../i18n'
import type { Journey, Locale } from '../domain/types'

export function JourneyTimeline({ journey, locale, activeLegIndex, evaluation, onSelectLeg, originName, destinationName, unavailableStopLegIndices = [] }: { journey: Journey; locale: Locale; activeLegIndex: number | null; evaluation: ConnectionEvaluation; onSelectLeg: (index: number) => void; originName?: string; destinationName?: string; unavailableStopLegIndices?: readonly number[] }) {
  const de = locale === 'de'
  return <div className="journey-timeline"><h3>{de ? 'Fahrplan' : 'Timeline'}</h3><ol>
    {journey.legs.map((leg, index) => {
      const departure = effectiveEventTime(leg, 'departure')
      const arrival = effectiveEventTime(leg, 'arrival')
      const transfer = evaluation.transfers.find(item => item.toLegIndex === index)
      const status = transfer && (transfer.status === 'feasible' ? (de ? 'Umstieg laut Fahrplan möglich' : 'Transfer fits timetable') : transfer.status === 'tight' ? (de ? 'Knapper Umstieg' : 'Tight transfer') : transfer.status === 'unreachable' ? (de ? 'Umstieg laut Fahrplan nicht möglich' : 'Transfer does not fit timetable') : (de ? 'Nur Fahrplan' : 'Timetable only'))
      return <li key={`${index}-${leg.startTime}`} className={index === activeLegIndex ? 'journey-timeline__active' : ''}>
        <button type="button" className="journey-timeline__leg" aria-pressed={index === activeLegIndex} onClick={() => onSelectLeg(index)}><strong>{leg.mode === 'WALK' ? (de ? 'Zu Fuß' : 'Walk') : `${leg.mode === 'TRAM' ? (de ? 'Straßenbahn' : 'Tram') : 'Bus'} ${leg.routeShortName} → ${leg.headsign}`}</strong><span>{index === 0 && originName ? originName : leg.from.name}{leg.from.track ? ` (${leg.from.track})` : ''} → {index === journey.legs.length - 1 && destinationName ? destinationName : leg.to.name}{leg.to.track ? ` (${leg.to.track})` : ''}</span><span>{departure.timeMs !== null && formatTimeWithDay(departure.timeMs, Date.parse(journey.startTime), locale)}{arrival.timeMs !== null && ` – ${formatTimeWithDay(arrival.timeMs, Date.parse(journey.startTime), locale)}`} · {formatDuration(leg.duration, locale)} · {departure.provenance === 'predicted' ? (de ? 'Prognose' : 'Predicted') : (de ? 'Fahrplan' : 'Scheduled')}</span></button>
        {transfer && <p>{status}{transfer.slackSeconds !== null && transfer.slackSeconds >= 0 && ` · ${de ? 'Zeit nach Fußweg' : 'Time after walking'}: ${formatDuration(transfer.slackSeconds, locale)}`}{transfer.interlined && ` · ${de ? 'Durchgebundene Fahrt' : 'Through service'}`}</p>}
        {((leg.mode === 'WALK' && !!leg.steps?.length) || (leg.mode !== 'WALK' && (!!leg.intermediateStops?.length || (leg.intermediateStops === undefined && unavailableStopLegIndices.includes(index))))) && <details><summary>{de ? 'Details' : 'Details'}</summary>{leg.mode === 'WALK' ? <ul>{leg.steps?.map((step, i) => <li key={i}>{[step.relativeDirection?.replaceAll('_', ' '), step.streetName, step.distance != null ? `${Math.round(step.distance)} m` : ''].filter(Boolean).join(' · ')}</li>)}</ul> : leg.intermediateStops === undefined ? <p>{translate(locale, 'stopDetailsUnavailable')}</p> : <ul>{leg.intermediateStops.map((stop, i) => <li key={i}>{stop.name}{stop.track ? ` (${stop.track})` : ''}</li>)}</ul>}</details>}
      </li>
    })}
  </ol></div>
}
