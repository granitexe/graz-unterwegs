import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { isInGraz } from '../domain/geography'
import type { LocationFix } from '../domain/types'

export type LocationStatus = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable' | 'outside'
export interface LocationState {
  fix: LocationFix | null
  status: LocationStatus
  enabled: boolean
  requestLocation(): Promise<LocationFix | null>
  stopLocation(): void
}

const LocationContext = createContext<LocationState | null>(null)
const options: PositionOptions = { timeout: 10_000, maximumAge: 30_000 }

export function LocationProvider({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const [fix, setFix] = useState<LocationFix | null>(null)
  const [status, setStatus] = useState<LocationStatus>('idle')
  const [enabled, setEnabled] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  const pending = useRef<Promise<LocationFix | null> | null>(null)
  const cancelPending = useRef<(() => void) | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  const accept = useCallback((position: GeolocationPosition): LocationFix | null => {
    const { latitude: lat, longitude: lon, accuracy } = position.coords
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(accuracy) || accuracy < 0) {
      setStatus('unavailable')
      return null
    }
    const coordinate = { lat, lon }
    if (!isInGraz(coordinate)) {
      setStatus('outside')
      return null
    }
    const next = { coordinate, accuracyM: accuracy, capturedAt: Number.isFinite(position.timestamp) ? position.timestamp : Date.now() }
    setFix(next)
    setStatus('ready')
    return next
  }, [])

  const requestLocation = useCallback((): Promise<LocationFix | null> => {
    if (pending.current) return pending.current
    if (!navigator.geolocation) {
      setStatus('unavailable')
      return Promise.resolve(null)
    }
    setStatus('locating')
    const current = ++generation.current
    let resolveRequest!: (fix: LocationFix | null) => void
    const promise = new Promise<LocationFix | null>(resolve => { resolveRequest = resolve })
    pending.current = promise
    const finish = (result: LocationFix | null) => {
      if (current !== generation.current) return
      pending.current = null
      cancelPending.current = null
      resolveRequest(result)
    }
    cancelPending.current = () => { pending.current = null; cancelPending.current = null; resolveRequest(null) }
    try {
      navigator.geolocation.getCurrentPosition(position => {
        if (current !== generation.current) return
        const next = accept(position)
        if (next) setEnabled(true)
        finish(next)
      }, error => {
        if (current !== generation.current) return
        setStatus(error.code === 1 ? 'denied' : 'unavailable')
        finish(null)
      }, options)
    } catch {
      setStatus('unavailable')
      finish(null)
    }
    return promise
  }, [accept])

  const stopLocation = useCallback(() => {
    generation.current++
    cancelPending.current?.()
    setEnabled(false)
    setStatus('idle')
  }, [])

  useEffect(() => {
    if (!enabled || !active || !visible || !navigator.geolocation) return
    let watching = true
    let watchId: number
    try {
      watchId = navigator.geolocation.watchPosition(position => {
        if (watching) accept(position)
      }, error => {
        if (watching) setStatus(error.code === 1 ? 'denied' : 'unavailable')
      }, options)
    } catch {
      setStatus('unavailable')
      return
    }
    return () => { watching = false; navigator.geolocation.clearWatch(watchId) }
  }, [enabled, active, visible, accept])

  useEffect(() => () => {
    generation.current++
    cancelPending.current?.()
  }, [])

  const value = useMemo(() => ({ fix, status, enabled, requestLocation, stopLocation }), [fix, status, enabled, requestLocation, stopLocation])
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>
}

export function useLocation(): LocationState {
  const value = useContext(LocationContext)
  if (!value) throw new Error('useLocation must be used within LocationProvider')
  return value
}
