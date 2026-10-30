import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { isInGraz } from '../domain/geography'
import type { Locale, PlaceChoice, PlaceSearchMode, PlaceSearchResult } from '../domain/types'
import { translate } from '../i18n'
import type { TranslationKey } from '../i18n'
import { Icon } from './Icon'
import { useLocation } from '../state/location'
import './PlaceSearch.css'

export interface PlaceSearchProps {
  label: string
  locale: Locale
  value: PlaceChoice | null
  onChange: (choice: PlaceChoice | null) => void
  searchPlaces: (text: string, mode: PlaceSearchMode, locale: Locale, signal: AbortSignal) => Promise<PlaceSearchResult>
  mode?: PlaceSearchMode
  allowLocation?: boolean
  onLocationSelected?: () => void
  active?: boolean
}

export function PlaceSearch({ label, locale, value, onChange, searchPlaces, mode = 'ALL', allowLocation = false, active: enabled = true, onLocationSelected }: PlaceSearchProps) {
  const { requestLocation, status: locationStatus } = useLocation()
  const [locationFailed, setLocationFailed] = useState(false)
  const id = useId()
  const [text, setText] = useState(value?.name ?? '')
  const [choices, setChoices] = useState<PlaceChoice[]>([])
  const [visibleCount, setVisibleCount] = useState(8)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<TranslationKey | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const [retryAt, setRetryAt] = useState(0)
  const [clock, setClock] = useState(Date.now())
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const skipSync = useRef(false)
  const searchRef = useRef(searchPlaces)
  searchRef.current = searchPlaces
  const t = (key: TranslationKey) => translate(locale, key)

  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    if (!locationFailed || locationStatus === 'locating') return
    setMessage(locationStatus === 'outside' ? 'outOfArea' : 'locationUnavailable')
    setLocationFailed(false)
  }, [locationFailed, locationStatus])
  useEffect(() => {
    if (retryAt <= clock) return
    const timer = window.setTimeout(() => setClock(Date.now()), retryAt - clock)
    return () => window.clearTimeout(timer)
  }, [retryAt, clock])

  useEffect(() => {
    if (skipSync.current) { skipSync.current = false; return }
    setText(value?.name ?? '')
    setAccuracy(null)
    setChoices([])
    setOpen(false)
  }, [value])

  useEffect(() => {
    const request = ++generation.current
    setChoices([])
    setActive(-1)
    if (!enabled || value || !text.trim()) {
      setLoading(false)
      setMessage(null)
      return
    }
    if (retryAt > Date.now()) {
      setLoading(false)
      setMessage('rateLimited')
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setMessage(null)
    const timer = window.setTimeout(() => {
      searchRef.current(text.trim(), mode, locale, controller.signal).then((result) => {
        if (controller.signal.aborted || request !== generation.current) return
        const inGraz = result.choices.filter((choice) => isInGraz(choice.coordinate))
        setChoices(inGraz)
        setVisibleCount(8)
        setActive(-1)
        setLoading(false)
        setMessage(result.incomplete ? (inGraz.length ? 'someResultsUnavailable' : 'placeServiceUnavailable') : inGraz.length ? null : result.choices.length ? 'outOfArea' : 'noSuggestions')
      }).catch((error: unknown) => {
        if (controller.signal.aborted || request !== generation.current) return
        setLoading(false)
        setChoices([])
        const detail = typeof error === 'object' && error !== null ? error as { kind?: string; retryAfterMs?: number } : {}
        const keys: Record<string, TranslationKey> = { 'rate-limited': 'rateLimited', network: 'networkError', unavailable: 'routingUnavailable', malformed: 'malformedResponse', 'out-of-area': 'outOfArea' }
        setMessage(keys[detail.kind ?? ''] ?? (error instanceof TypeError ? 'networkError' : 'malformedResponse'))
        if (detail.kind === 'rate-limited' && Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs! > 0) {
          const now = Date.now()
          setClock(now)
          setRetryAt(now + detail.retryAfterMs!)
        }
      })
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [text, mode, locale, value, retry, retryAt, enabled])

  function select(choice: PlaceChoice) {
    generation.current++
    setText(choice.name)
    setChoices([])
    setOpen(false)
    setMessage(null)
    setAccuracy(null)
    onChange(choice)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const count = Math.min(choices.length, visibleCount)
      if (!count) return
      event.preventDefault()
      setOpen(true)
      setActive((previous) => event.key === 'ArrowDown' ? (previous + 1) % count : (previous <= 0 ? count - 1 : previous - 1))
    } else if (event.key === 'Enter' && open && active >= 0 && choices[active]) {
      event.preventDefault()
      select(choices[active])
    } else if (event.key === 'Escape') {
      setOpen(false)
      setActive(-1)
    }
  }

  async function selectLocation() {
    const request = ++generation.current
    setOpen(false)
    setLoading(false)
    setMessage(null)
    setLocationFailed(false)
    const fix = await requestLocation()
    if (request !== generation.current) return
    if (!fix) { setLocationFailed(true); return }
    const choice: PlaceChoice = { kind: 'ADDRESS', name: t('useLocation'), coordinate: fix.coordinate }
    setText(choice.name)
    setChoices([])
    setAccuracy(fix.accuracyM)
    skipSync.current = true
    onChange(choice)
    onLocationSelected?.()
  }

  return <div className="place-search" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }}>
    <label htmlFor={`${id}-input`}>{label}</label>
    <div className="place-search-input">
    <input id={`${id}-input`} role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open && choices.length > 0} aria-controls={`${id}-list`} aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined} value={text} onFocus={() => setOpen(true)} onKeyDown={onKeyDown} onChange={(event) => {
      generation.current++
      setText(event.target.value)
      setChoices([])
      setOpen(true)
      setAccuracy(null)
      setMessage(null)
      if (value) { skipSync.current = true; onChange(null) }
    }} />
    {allowLocation && <button className="place-search-location" type="button" onClick={selectLocation} aria-label={t('useLocation')} title={t('useLocation')}><Icon name="my_location" /></button>}
    {open && choices.length > 0 && <div className="place-search-suggestions">
      <ul id={`${id}-list`} role="listbox" aria-label={label}>
        {choices.slice(0, visibleCount).map((choice, index) => {
          const icon = choice.kind === 'STOP' ? 'directions_bus' : 'search'
          const url = `${import.meta.env.BASE_URL}icons/${icon}.svg`
          const street = choice.street ? `${choice.street}${choice.houseNumber ? ` ${choice.houseNumber}` : ''}` : ''
          const context = [choice.subtitle, street && street !== choice.name ? street : '', choice.kind === 'ADDRESS' && choice.street && !choice.houseNumber ? t('streetNoHouseNumber') : ''].filter(Boolean).join(' · ')
          return <li key={`${choice.stopId ?? `${choice.coordinate.lat},${choice.coordinate.lon}`}-${choice.name}-${index}`} id={`${id}-option-${index}`} role="option" aria-selected={index === active} onPointerDown={(event) => event.preventDefault()} onClick={() => select(choice)}>
            <span className="place-search-icon" aria-hidden="true" style={{ maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` }} />
            <span className="place-search-result"><small>{t(choice.kind === 'STOP' ? 'stopType' : 'addressType')}</small><span>{choice.name}</span>{context && <small>{context}</small>}</span>
          </li>
        })}
      </ul>
      {choices.length > visibleCount && <button type="button" onClick={() => setVisibleCount(choices.length)}>{t('moreResults')}</button>}
    </div>}
    </div>
    {accuracy !== null && <p>{t('locationAccuracy')}: ±{Math.round(accuracy)} m</p>}
    <div role="status" aria-live="polite">{loading ? t('searchingPlaces') : message ? t(message) : null}</div>
    {message && ['rateLimited', 'networkError', 'malformedResponse', 'routingUnavailable', 'placeServiceUnavailable', 'someResultsUnavailable'].includes(message) && <button type="button" disabled={retryAt > clock} onClick={() => setRetry((current) => current + 1)}>{t('retry')}</button>}
  </div>
}
