import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Journey, JourneyPage, JourneyQuery, Locale, PlaceChoice } from '../domain/types'
import { translate } from '../i18n'
import type { TranslationKey } from '../i18n'
import { planJourney, searchPlaces } from '../services/transitous'
import { JourneyResults } from './JourneyResults'
import { Icon } from './Icon'
import { PlaceSearch } from './PlaceSearch'
import './JourneyResults.css'

export interface JourneySearchProps {
  locale: Locale
  onSelect: (journey: Journey, query: JourneyQuery) => void
  initialOrigin?: PlaceChoice | null
  initialDestination?: PlaceChoice | null
  onPlacesChange?: (origin: PlaceChoice | null, destination: PlaceChoice | null) => void
  onOriginLocationSelected?: () => void
  initialTimeMs?: number
  active?: boolean
}

export function JourneySearch({ locale, onSelect, initialOrigin = null, initialDestination = null, initialTimeMs, active = true, onPlacesChange, onOriginLocationSelected }: JourneySearchProps) {
  const [origin, setOrigin] = useState<PlaceChoice | null>(initialOrigin)
  const [originTime, setOriginTime] = useState(initialTimeMs)
  const [destination, setDestination] = useState<PlaceChoice | null>(initialDestination)
  const [query, setQuery] = useState<JourneyQuery | null>(null)
  const [page, setPage] = useState<JourneyPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [stale, setStale] = useState(false)
  const [alreadyThere, setAlreadyThere] = useState(false)
  const [error, setError] = useState<TranslationKey | null>(null)
  const [retryAt, setRetryAt] = useState(0)
  const [clock, setClock] = useState(Date.now())
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const failed = useRef<{ query: JourneyQuery; append: boolean } | null>(null)
  const t = (key: TranslationKey) => translate(locale, key)

  useEffect(() => () => { generation.current++; request.current?.abort() }, [])
  useEffect(() => {
    if (active) return
    generation.current++
    request.current?.abort()
    setLoading(false)
  }, [active])
  useEffect(() => {
    if (retryAt <= clock) return
    const timer = window.setTimeout(() => setClock(Date.now()), retryAt - clock)
    return () => window.clearTimeout(timer)
  }, [retryAt, clock])
  useEffect(() => { setOrigin(initialOrigin) }, [initialOrigin])
  useEffect(() => { setDestination(initialDestination) }, [initialDestination])
  useEffect(() => { if (active) onPlacesChange?.(origin, destination) }, [active, origin, destination, onPlacesChange])

  function changed() {
    generation.current++
    request.current?.abort()
    setLoading(false)
    setAlreadyThere(false)
    setError(null)
    setStale(current => current || page !== null)
    failed.current = null
  }

  async function run(next: JourneyQuery, append: boolean) {
    if (Date.now() < retryAt) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const current = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await planJourney(next, controller.signal)
      if (controller.signal.aborted || current !== generation.current) return
      setPage(previous => append && previous ? { ...result, journeys: [...previous.journeys, ...result.journeys.filter(item => !previous.journeys.some(existing => existing.id === item.id))] } : result)
      setQuery(append ? { ...next, pageCursor: undefined } : next)
      setStale(false)
      setAlreadyThere(false)
      failed.current = null
    } catch (caught) {
      if (controller.signal.aborted || current !== generation.current) return
      const detail = typeof caught === 'object' && caught !== null ? caught as { kind?: string; retryAfterMs?: number } : {}
      const errors: Record<string, TranslationKey> = { 'rate-limited': 'rateLimited', network: 'networkError', unavailable: 'routingUnavailable', malformed: 'malformedResponse', 'out-of-area': 'outOfArea' }
      setError(errors[detail.kind ?? ''] ?? 'networkError')
      setStale(page !== null)
      failed.current = { query: next, append }
      if (detail.kind === 'rate-limited' && detail.retryAfterMs && detail.retryAfterMs > 0) {
        const now = Date.now()
        setClock(now)
        setRetryAt(now + detail.retryAfterMs)
      }
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!origin || !destination || Date.now() < retryAt) return
    const same = origin.stopId && destination.stopId ? origin.stopId === destination.stopId : origin.coordinate.lat === destination.coordinate.lat && origin.coordinate.lon === destination.coordinate.lon
    if (same) {
      request.current?.abort()
      generation.current++
      setLoading(false)
      setPage(null)
      setQuery(null)
      setError(null)
      setAlreadyThere(true)
      return
    }
    void run({ origin, destination, locale, timeMs: Math.max(Date.now(), originTime ?? 0), walkingSpeed: 1.2 }, false)
  }

  return <div className="journey-search">
    <form onSubmit={submit}>
      <div className="journey-search__fields">
        <div className="journey-search__endpoint"><span className="journey-search__letter" aria-hidden="true">A</span><PlaceSearch label={t('origin')} locale={locale} value={origin} onChange={value => { changed(); setOrigin(value); setOriginTime(undefined) }} searchPlaces={searchPlaces} allowLocation active={active} onLocationSelected={onOriginLocationSelected} /></div>
        <button className="journey-search__swap" type="button" onClick={() => { changed(); setOrigin(destination); setDestination(origin); setOriginTime(undefined) }} aria-label={t('swap')} title={t('swap')}><Icon name="swap_vert" /></button>
        <div className="journey-search__endpoint"><span className="journey-search__letter" aria-hidden="true">B</span><PlaceSearch label={t('destination')} locale={locale} value={destination} onChange={value => { changed(); setDestination(value) }} searchPlaces={searchPlaces} active={active} /></div>
      </div>
      <button className="journey-search__submit" type="submit" disabled={!origin || !destination || loading || retryAt > clock}>{loading ? (locale === 'de' ? 'Suche…' : 'Searching…') : t('search')}</button>
    </form>
    {alreadyThere && <p role="status">{t('alreadyThere')}</p>}
    {error && <div role="alert"><p>{t(error)}</p>{failed.current && <button type="button" disabled={loading || retryAt > clock} onClick={() => { if (failed.current) void run(failed.current.query, failed.current.append) }}>{t('retry')}</button>}</div>}
    {page && !page.journeys.length && !error && <p role="status">{t('noConnections')}</p>}
    {page && query && <JourneyResults key={`${query.timeMs}-${query.origin.name}-${query.destination.name}`} journeys={page.journeys} locale={locale} stale={stale} loading={loading} onSelect={journey => onSelect(journey, query)} onLater={!stale && page.nextPageCursor ? () => void run({ ...query, pageCursor: page.nextPageCursor }, true) : undefined} />}
  </div>
}
