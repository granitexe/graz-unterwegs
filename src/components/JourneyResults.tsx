import { useState } from 'react'
import { effectiveEventTime } from '../domain/connections'
import { formatDuration, formatTime, formatTimeWithDay } from '../domain/formatting'
import type { Journey, Leg, Locale } from '../domain/types'
import { translate } from '../i18n'
import './JourneyResults.css'

export interface JourneyResultsProps {
  journeys: Journey[]
  locale: Locale
  stale?: boolean
  onSelect: (journey: Journey) => void
  onLater?: () => void
  loading?: boolean
}

function event(leg: Leg, end: boolean) {
  const result = effectiveEventTime(leg, end ? 'arrival' : 'departure')
  return { time: result.timeMs ?? Date.parse(end ? leg.scheduledEndTime : leg.scheduledStartTime), predicted: result.provenance === 'predicted' }
}

function walking(journey: Journey) {
  return journey.legs.reduce((sum, leg) => sum + (leg.mode === 'WALK' ? leg.duration : 0), 0)
}

export function JourneyResults({ journeys, locale, stale = false, onSelect, onLater, loading = false }: JourneyResultsProps) {
  const [visible, setVisible] = useState(5)
  const sorted = [...journeys].sort((a, b) => event(a.legs[a.legs.length - 1], true).time - event(b.legs[b.legs.length - 1], true).time || a.transfers - b.transfers || walking(a) - walking(b))
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key)
  return <section className="journey-results" aria-label={locale === 'de' ? 'Verbindungen' : 'Connections'}>
    {stale && <p role="status">{t('staleResults')}</p>}
    <div className="journey-results-list">{sorted.slice(0, visible).map((journey, index) => {
      const first = event(journey.legs[0], false)
      const last = event(journey.legs[journey.legs.length - 1], true)
      const transit = journey.legs.filter(leg => leg.mode !== 'WALK')
      return <article className="journey-result" key={`${journey.id}-${index}`}>
        <button type="button" className="journey-result-select" onClick={() => onSelect(journey)}>
          <span className="journey-result-times"><strong>{formatTime(first.time, locale)} – {formatTimeWithDay(last.time, first.time, locale)}</strong><span>{formatDuration(journey.duration, locale)}</span></span>
          <span className="journey-result-provenance">{t(first.predicted ? 'predicted' : 'scheduled')} → {t(last.predicted ? 'predicted' : 'scheduled')}</span>
          {transit.length === 0 ? <strong>{t('directWalk')}</strong> : <span className="journey-result-legs">{transit.map((leg, legIndex) => <span className="journey-result-leg" key={`${leg.tripId}-${legIndex}`}>{legIndex > 0 && <span className="journey-result-arrow" aria-hidden="true">→</span>}<strong>{t(leg.mode === 'BUS' ? 'bus' : 'tram')} {leg.routeShortName}</strong>{(leg.cancelled || leg.from.cancelled || leg.to.cancelled) && <small> · {locale === 'de' ? 'Entfällt' : 'Cancelled'}</small>}</span>)}</span>}
          <span className="journey-result-summary">{locale === 'de' ? `${journey.transfers} Umstiege` : `${journey.transfers} changes`} · {t('walk')} {formatDuration(walking(journey), locale)}</span>
        </button>
      </article>
    })}</div>
    {visible < sorted.length && <button type="button" onClick={() => setVisible(n => n + 5)}>{t('more')}</button>}
    {onLater && <button type="button" disabled={loading} onClick={onLater}>{t('laterConnections')}</button>}
  </section>
}
