import type { Locale } from '../domain/types'
import { de } from './de'
import { en } from './en'

export type TranslationKey = keyof typeof en
export const translations: Record<Locale, Record<TranslationKey, string>> = { de, en }
export const LOCALE_STORAGE_KEY = 'graz-unterwegs-locale'

export function translate(locale: Locale, key: TranslationKey): string {
  return translations[locale][key]
}

export function getInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (saved === 'de' || saved === 'en') return saved
  } catch {
    // Storage may be disabled; the browser preference still works.
  }
  if (typeof navigator !== 'undefined') {
    const preferences = navigator.languages?.length ? navigator.languages : [navigator.language]
    for (const preference of preferences) {
      const language = preference?.split('-')[0]?.toLowerCase()
      if (language === 'de' || language === 'en') return language
    }
  }
  return 'en'
}

export function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Rendering and language switching must also work without storage.
  }
}
