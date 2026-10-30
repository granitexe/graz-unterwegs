import { GRAZ_EXTENT, OPEN_TRAFFIC_MAP_SOCKET } from '../config'
import { isInGraz } from '../domain/geography'
import type { Coordinate, PositionStatus, TransitMode } from '../domain/types'

// Feed identities are session identities, not timetable trip identifiers.
export interface VehicleObservation {
  id: string
  mode: TransitMode
  coordinate: Coordinate
  observedAt: number
  lineDisplay: string
  targetName: string
  course?: string
  vehicleNumber?: string
  heading?: number
  speed?: number
}
export interface FeedStatus {
  state: 'connecting' | 'connected' | 'disconnected' | 'paused'
  nowMs: number
}

export function positionStatus(observedAt: number, nowMs: number): PositionStatus {
  if (!Number.isFinite(observedAt) || !Number.isFinite(nowMs) || observedAt > nowMs + 5000) return 'missing'
  const age = Math.max(0, nowMs - observedAt)
  return age <= 30000 ? 'fresh' : age <= 120000 ? 'stale' : 'missing'
}

type RecordValue = Record<string, unknown>
type Feature = { id: string; geometry?: unknown; properties: RecordValue }
type Tile = { seq: number; points: Map<string, Feature>; waiting: boolean }
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
const timestamp = (value: unknown): number => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN
const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []

function feature(value: unknown, fallbackId = ''): Feature | undefined {
  const raw = object(value)
  if (!raw) return undefined
  const id = text(raw.id) || fallbackId
  if (!id) return undefined
  return { id, geometry: raw.geometry, properties: { ...object(raw.properties) } }
}

export function cityTiles(): string[] {
  const z = 12, n = 2 ** z
  const x = (lon: number) => Math.floor((lon + 180) / 360 * n)
  const y = (lat: number) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)
  const tiles: string[] = []
  for (let tx = x(GRAZ_EXTENT.west); tx <= x(GRAZ_EXTENT.east); tx++)
    for (let ty = y(GRAZ_EXTENT.north); ty <= y(GRAZ_EXTENT.south); ty++) tiles.push(`${z}/${tx}/${ty}`)
  return tiles
}

// Kept separate from socket lifecycle so a batch is committed before observers see it.
export class TiledVehicleState {
  private readonly subscribed: readonly string[]
  private readonly resync: (tile: string) => void
  constructor(subscribed: readonly string[], resync: (tile: string) => void) {
    this.subscribed = subscribed
    this.resync = resync
  }
  private tiles = new Map<string, Tile>()

  clear(): void { this.tiles.clear() }
  private requestResync(id: string): void {
    const tile = this.tiles.get(id)
    if (tile?.waiting) return
    if (tile) tile.waiting = true
    else this.tiles.set(id, { seq: 0, points: new Map(), waiting: true })
    this.resync(id)
  }
  apply(message: RecordValue): boolean {
    const type = message.type
    if (type === 'tile-fullstatus') {
      const id = text(message.tile), state = object(message.state), points = object(state?.points)
      const seq = numeric(message.seq)
      if (!this.subscribed.includes(id) || !points || seq === undefined || (message.generation !== undefined && message.generation !== 1)) return false
      const next = new Map<string, Feature>()
      for (const [key, value] of Object.entries(points)) {
        const item = feature(value, key)
        if (item) next.set(item.id, item)
      }
      this.tiles.set(id, { seq, points: next, waiting: false })
      return true
    }
    if (type === 'tile-delta') return this.delta(message)
    if (type === 'tile-delta-batch') {
      let changed = false
      for (const value of list(message.deltas)) {
        const delta = object(value)
        if (delta && this.delta(delta, message)) changed = true
      }
      return changed
    }
    return false
  }
  private delta(message: RecordValue, dictionaries?: RecordValue): boolean {
    const id = text(message.tile)
    if (!this.subscribed.includes(id) || (message.generation !== undefined && message.generation !== 1)) return false
    const tile = this.tiles.get(id)
    if (tile?.waiting) return false
    const seq = numeric(message.seq), base = numeric(message.baseSeq)
    if (!tile || seq === undefined || base === undefined || base !== tile.seq) { this.requestResync(id); return false }
    const points = new Map(tile.points)
    const resolve = (direct: string, ids: string, dict: string): unknown[] | undefined => {
      if (!dictionaries) return list(message[direct])
      const dictionary = object(dictionaries[dict])
      const keys = list(message[ids])
      if (keys.some(key => !dictionary || !Object.hasOwn(dictionary, text(key)))) return undefined
      return keys.map(key => dictionary![text(key)])
    }
    const upserts = resolve('upsertPoints', 'upsertPointIds', 'pointsById')
    const patches = resolve('patchPoints', 'patchPointIds', 'pointPatchesById')
    if (!upserts || !patches) { this.requestResync(id); return false }
    for (const value of upserts) {
      const item = feature(value)
      if (!item) { this.requestResync(id); return false }
      points.set(item.id, item)
    }
    for (const value of patches) {
      const patch = object(value), patchId = text(patch?.id), previous = points.get(patchId)
      if (!patch || !previous) { this.requestResync(id); return false }
      const properties = { ...previous.properties, ...object(patch.properties) }
      for (const key of list(patch.removeProperties)) if (typeof key === 'string') delete properties[key]
      points.set(patchId, { ...previous, properties, ...(Object.hasOwn(patch, 'geometry') ? { geometry: patch.geometry } : {}) })
    }
    for (const removed of list(message.removePoints)) points.delete(text(removed))
    this.tiles.set(id, { seq, points, waiting: false })
    return true
  }
  observations(nowMs: number): VehicleObservation[] {
    const merged = new Map<string, VehicleObservation>()
    for (const tile of this.tiles.values()) for (const item of tile.points.values()) {
      const p = item.properties, geometry = object(item.geometry), coords = list(geometry?.coordinates)
      const lon = numeric(coords[0]), lat = numeric(coords[1]), kind = text(p.kind).toLowerCase()
      const city = text(p.transitCity).trim()
      const observedAt = timestamp(p.lastSeen)
      if (geometry?.type !== 'Point' || lon === undefined || lat === undefined || (kind !== 'bus' && kind !== 'tram') || (city && city.toLowerCase() !== 'graz') || !isInGraz({ lat, lon }) || positionStatus(observedAt, nowMs) === 'missing') continue
      const result: VehicleObservation = { id: item.id, mode: kind === 'bus' ? 'BUS' : 'TRAM', coordinate: { lat, lon }, observedAt, lineDisplay: text(p.transitLineDisplay), targetName: text(p.transitTargetName) }
      const course = text(p.transitCourseCode), vehicleNumber = text(p.vehicleNumber), heading = numeric(p.headingDeg), speed = numeric(p.speedKmh)
      if (course) result.course = course
      if (vehicleNumber) result.vehicleNumber = vehicleNumber
      if (heading !== undefined) result.heading = heading
      if (speed !== undefined) result.speed = speed
      if (!merged.has(item.id) || merged.get(item.id)!.observedAt < observedAt) merged.set(item.id, result)
    }
    return [...merged.values()]
  }
}

export function connectVehicles(onUpdate: (vehicles: readonly VehicleObservation[], status: FeedStatus) => void): () => void {
  let socket: WebSocket | undefined, stopped = false, state: FeedStatus['state'] = 'connecting'
  let retry: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setInterval> | undefined
  let attempt = 0, lastData = 0, serverTime = NaN, serverTick = 0
  const monotonic = () => performance.now()
  const now = () => Number.isFinite(serverTime) ? serverTime + Math.max(0, monotonic() - serverTick) : Date.now()
  const tiles = cityTiles()
  const data = new TiledVehicleState(tiles, tile => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tile-resync', tile, generation: 1 }))
  })
  const emit = () => onUpdate(data.observations(now()), { state, nowMs: now() })
  const clearTimers = () => { if (retry !== undefined) clearTimeout(retry); if (watchdog !== undefined) clearInterval(watchdog); retry = undefined; watchdog = undefined }
  const close = () => { const old = socket; socket = undefined; if (old) { old.onclose = null; old.onerror = null; old.onmessage = null; old.onopen = null; old.close() } }
  const schedule = () => {
    clearTimers(); close()
    if (stopped || document.hidden) return
    state = 'disconnected'; emit()
    const delay = [1000, 2000, 4000, 8000, 16000, 30000][Math.min(attempt++, 5)]
    retry = setTimeout(start, delay + Math.random() * 250)
  }
  const start = () => {
    if (stopped || document.hidden || socket) return
    clearTimers(); data.clear(); state = 'connecting'; emit(); lastData = monotonic()
    try { socket = new WebSocket(OPEN_TRAFFIC_MAP_SOCKET) } catch { schedule(); return }
    const current = socket
    current.onopen = () => { if (socket === current) current.send(JSON.stringify({ type: 'subscribe-tiles', generation: 1, tiles })) }
    current.onmessage = event => {
      if (socket !== current || typeof event.data !== 'string') return
      let message: RecordValue | undefined
      try { message = object(JSON.parse(event.data)) } catch { return }
      if (!message) return
      lastData = monotonic()
      const receivedTime = timestamp(message.now)
      if (Number.isFinite(receivedTime)) { serverTime = Number.isFinite(serverTime) ? Math.max(now(), receivedTime) : receivedTime; serverTick = monotonic() }
      const changed = data.apply(message)
      if (message.type === 'tile-fullstatus' && changed) { attempt = 0; state = 'connected' }
      if (changed || message.type === 'hello') emit()
    }
    current.onerror = () => { if (socket === current) schedule() }
    current.onclose = () => { if (socket === current) schedule() }
    watchdog = setInterval(() => { if (monotonic() - lastData >= 30000) schedule(); else emit() }, 1000)
  }
  const visibility = () => {
    if (document.hidden) { clearTimers(); close(); data.clear(); state = 'paused'; emit() }
    else if (!socket && retry === undefined) start()
  }
  const focus = () => { if (!document.hidden && !socket && retry === undefined) start() }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('focus', focus)
  if (document.hidden) { state = 'paused'; emit() } else start()
  return () => { stopped = true; clearTimers(); close(); data.clear(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus) }
}
