import type { Locale } from './types'

export const TIME_ZONE = 'Europe/Vienna'

type Instant = number | Date

export function formatTime(instant: Instant, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(instant)
}

export function formatDate(instant: Instant, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(instant)
}

// Compare civil dates in Vienna rather than dates in the device's timezone.
function civilDay(instant: Instant): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant)
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-')
}

export function formatDayLabel(instant: Instant, reference: Instant, locale: Locale): string {
  return civilDay(instant) === civilDay(reference)
    ? (locale === 'de' ? 'Heute' : 'Today')
    : formatDate(instant, locale)
}

export function formatTimeWithDay(instant: Instant, reference: Instant, locale: Locale): string {
  const time = formatTime(instant, locale)
  return civilDay(instant) === civilDay(reference) ? time : `${formatDate(instant, locale)}, ${time}`
}

export function formatDuration(seconds: number, locale: Locale): string {
  const minutes = Math.max(0, Math.ceil(seconds / 60))
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  const number = new Intl.NumberFormat(locale)
  if (!hours) return `${number.format(minutes)} min`
  return remaining ? `${number.format(hours)} h ${number.format(remaining)} min` : `${number.format(hours)} h`
}

// Delay is signed, so early events are not presented as late.
export function formatDelay(seconds: number, locale: Locale): string {
  if (seconds === 0) return locale === 'de' ? 'Pünktlich' : 'On time'
  const minutes = Math.ceil(Math.abs(seconds) / 60)
  const value = new Intl.NumberFormat(locale).format(minutes)
  return seconds > 0
    ? (locale === 'de' ? `${value} Min. Verspätung` : `${value} min late`)
    : (locale === 'de' ? `${value} Min. früher` : `${value} min early`)
}
