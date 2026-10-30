import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as maplibregl from 'maplibre-gl'
import { setWorkerUrl, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson'
import { GRAZ_CENTER, MAP_STYLE_URL } from '../config'
import { isInGraz } from '../domain/geography'
import { buildJourneyFeatures } from '../domain/mapGeometry'
import { placeEdgeIndicator } from '../domain/mapViewport'
import { translate } from '../i18n'
import type { Journey, Locale, LocationFix, PlaceChoice } from '../domain/types'
import { Icon } from './Icon'
import { positionStatus, type VehicleObservation } from '../services/opentrafficmap'
import './TransitMap.css'

setWorkerUrl(workerUrl)

export type CameraMode = 'overview' | 'follow-user' | 'follow-vehicle' | 'free'
export interface MapScene {
  journey: Journey | null
  selectedLegIndex: number | null
  origin?: PlaceChoice
  destination?: PlaceChoice
  vehicles: readonly VehicleObservation[]
  eligibleVehicleId?: string
  liveStatus: 'idle' | 'loading' | 'live' | 'ambiguous' | 'unavailable'
  vehicleSelection: 'likely' | 'pinned' | null
  observationNowMs: number
}
export interface TransitMapProps {
  scene: MapScene
  locale: Locale
  locationFix: LocationFix | null
  locationStatus: 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable' | 'outside'
  cameraMode: CameraMode
  followVehicleId?: string
  onCameraModeChange: (mode: CameraMode) => void
  onSelectLeg: (index: number) => void
  onRequestLocation: () => Promise<LocationFix | null>
  onOverview: () => void
  occlusion: { top: number; right: number; bottom: number; left: number }
}

type Properties = Record<string, string | number | boolean>
type MapFeature = Feature<Geometry, Properties>
const collection = (features: MapFeature[]): FeatureCollection<Geometry, Properties> => ({ type: 'FeatureCollection', features })
const point = (lon: number, lat: number, properties: Properties): Feature<Point, Properties> => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties })

function visibleInsets(element: HTMLElement | null, occlusion: TransitMapProps['occlusion']) {
  const style = element ? getComputedStyle(element) : null
  const inset = (side: 'top' | 'right' | 'bottom' | 'left') => Math.max(occlusion[side], Number.parseFloat(style?.getPropertyValue(`--map-safe-${side}`) ?? '') || 0)
  return { top: inset('top'), right: inset('right'), bottom: inset('bottom'), left: inset('left') }
}

function locationFeatures(fix: LocationFix | null, now: number): MapFeature[] {
  if (!fix || !Number.isFinite(fix.coordinate.lat) || !Number.isFinite(fix.coordinate.lon) || !Number.isFinite(fix.accuracyM) || fix.accuracyM < 0 || !isInGraz(fix.coordinate)) return []
  const { lat, lon } = fix.coordinate
  const stale = now - fix.capturedAt > 30000 || fix.capturedAt > now + 5000
  const circle: number[][] = []
  for (let i = 0; i <= 64; i++) {
    const angle = i * Math.PI / 32
    circle.push([lon + Math.cos(angle) * fix.accuracyM / (111320 * Math.cos(lat * Math.PI / 180)), lat + Math.sin(angle) * fix.accuracyM / 111320])
  }
  return [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circle] }, properties: {} }, point(lon, lat, { stale })]
}

export default function TransitMap(props: TransitMapProps) {
  const { scene, locale, locationFix, locationStatus, cameraMode, followVehicleId, occlusion } = props
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const stopRef = useRef<HTMLDivElement>(null)
  const [vehiclePlacement, setVehiclePlacement] = useState<{ x: number; y: number; angleDeg: number; edge: boolean } | null>(null)
  const [stopCallout, setStopCallout] = useState<{ label: string; x: number; y: number; pinned: boolean } | null>(null)
  const [stopHeight, setStopHeight] = useState(64)
  const latest = useRef(props)
  latest.current = props
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [followPaused, setFollowPaused] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const [overviewRequest, setOverviewRequest] = useState(0)
  const [sizeVersion, setSizeVersion] = useState(0)
  const [attributionBand, setAttributionBand] = useState(40)
  const [statusHeight, setStatusHeight] = useState(0)
  const [controlsHeight, setControlsHeight] = useState(48)
  const de = locale === 'de'
  const geometry = useMemo(() => scene.journey ? buildJourneyFeatures(scene.journey, scene.selectedLegIndex) : null, [scene.journey, scene.selectedLegIndex])
  const location = useMemo(() => locationFeatures(locationStatus === 'outside' ? null : locationFix, clock), [locationFix, locationStatus, clock])
  const usableFix = location.length > 0 && locationFix !== null && clock - locationFix.capturedAt <= 30000 && locationFix.capturedAt <= clock + 5000 && locationFix.accuracyM <= 100
  const following = scene.vehicles.find(vehicle => vehicle.id === followVehicleId && vehicle.id === scene.eligibleVehicleId && positionStatus(vehicle.observedAt, scene.observationNowMs) === 'fresh')

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => { if (!followPaused) return; const timer = window.setTimeout(() => setFollowPaused(false), 5000); return () => window.clearTimeout(timer) }, [followPaused])

  useEffect(() => {
    if (!container.current) return
    let map: MapLibreMap
    try {
      map = new maplibregl.Map({ container: container.current, style: MAP_STYLE_URL, center: [GRAZ_CENTER.lon, GRAZ_CENTER.lat], zoom: 12, attributionControl: { compact: true }, pitch: 0, bearing: 0, maxPitch: 0, dragRotate: false, touchPitch: false })
    } catch { setError(true); return }
    mapRef.current = map
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.on('error', event => { if (!map.isStyleLoaded() && !('sourceId' in event)) setError(true) })
    map.on('style.load', () => {
      const source = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: collection([]) }) }
      ;['routes', 'stops', 'endpoints', 'vehicles', 'location'].forEach(source)
      const add = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
        if (map.getLayer(layer.id)) return
        map.addLayer(layer)
        if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'text-font', ['Noto Sans Regular'])
      }
      const walk: ['==', ['coalesce', ['get', string], boolean], boolean] = ['==', ['coalesce', ['get', 'walk'], false], true]
      const transit: ['==', ['coalesce', ['get', string], boolean], boolean] = ['==', ['coalesce', ['get', 'walk'], false], false]
      const opacity: ['case', ['boolean', ['get', string], boolean], number, number] = ['case', ['boolean', ['get', 'selected'], false], 1, 0.65]
      add({ id: 'route-transit-casing', type: 'line', source: 'routes', filter: transit, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fffdf6', 'line-width': 10, 'line-opacity': opacity } })
      add({ id: 'route-transit', type: 'line', source: 'routes', filter: transit, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#006b5e', 'line-width': ['case', ['boolean', ['get', 'selected'], false], 7, 6], 'line-opacity': opacity } })
      add({ id: 'route-walk-casing', type: 'line', source: 'routes', filter: walk, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fffdf6', 'line-width': 7, 'line-opacity': opacity } })
      add({ id: 'route-walk', type: 'line', source: 'routes', filter: walk, layout: { 'line-join': 'round' }, paint: { 'line-color': '#526575', 'line-width': 4, 'line-dasharray': [2, 2], 'line-opacity': opacity } })
      add({ id: 'route-directions', type: 'symbol', source: 'routes', layout: { 'symbol-placement': 'line', 'symbol-spacing': 180, 'text-field': '›', 'text-size': 20, 'text-keep-upright': false }, paint: { 'text-color': '#ffffff', 'text-halo-color': '#006b5e', 'text-halo-width': 1 } })
      add({ id: 'route-badges', type: 'symbol', source: 'routes', filter: transit, layout: { 'symbol-placement': 'line-center', 'text-field': ['concat', ['case', ['==', ['get', 'mode'], 'TRAM'], 'T ', 'B '], ['get', 'label']], 'text-size': 12, 'text-offset': [0, -1], 'text-optional': true }, paint: { 'text-color': '#004f46', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } })
      add({ id: 'stop-circles', type: 'circle', source: 'stops', filter: ['any', ['boolean', ['get', 'board'], false], ['boolean', ['get', 'alight'], false]], paint: { 'circle-radius': ['case', ['boolean', ['get', 'transfer'], false], 7, 5], 'circle-color': '#ffffff', 'circle-stroke-color': '#006b5e', 'circle-stroke-width': 2 } })
      add({ id: 'intermediate-circles', type: 'circle', source: 'stops', filter: ['all', ['boolean', ['get', 'intermediate'], false], ['!', ['boolean', ['get', 'board'], false]], ['!', ['boolean', ['get', 'alight'], false]]], paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#006b5e', 'circle-stroke-width': 2 } })
      add({ id: 'stop-labels', type: 'symbol', source: 'stops', minzoom: 14, layout: { 'text-field': ['concat', ['case', ['boolean', ['get', 'transfer'], false], '⇄ ', ''], ['get', 'label']], 'text-size': 12, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#17332e', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } })
      add({ id: 'stop-hit-target', type: 'circle', source: 'stops', paint: { 'circle-radius': 22, 'circle-color': '#000000', 'circle-opacity': 0.001 } })
      add({ id: 'endpoint-circles', type: 'circle', source: 'endpoints', paint: { 'circle-radius': 12, 'circle-color': '#006b5e', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } })
      add({ id: 'endpoint-labels', type: 'symbol', source: 'endpoints', layout: { 'text-field': ['get', 'letter'], 'text-size': 12, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } })
      add({ id: 'endpoint-names', type: 'symbol', source: 'endpoints', layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#17332e', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } })
      add({ id: 'location-accuracy', type: 'fill', source: 'location', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#1677dc', 'fill-opacity': 0.16 } })
      add({ id: 'location-dot', type: 'circle', source: 'location', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': ['case', ['boolean', ['get', 'stale'], false], '#ffffff', '#1677dc'], 'circle-stroke-color': ['case', ['boolean', ['get', 'stale'], false], '#1677dc', '#ffffff'], 'circle-stroke-width': 3 } })
      add({ id: 'vehicle-circles', type: 'circle', source: 'vehicles', filter: ['!=', ['get', 'primary'], true], paint: { 'circle-radius': 15, 'circle-color': ['case', ['boolean', ['get', 'stale'], false], '#ffffff', '#006b5e'], 'circle-stroke-color': '#006b5e', 'circle-stroke-width': 2 } })
      add({ id: 'vehicle-labels', type: 'symbol', source: 'vehicles', filter: ['!=', ['get', 'primary'], true], layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-allow-overlap': true }, paint: { 'text-color': ['case', ['boolean', ['get', 'stale'], false], '#006b5e', '#ffffff'] } })
      add({ id: 'vehicle-direction', type: 'symbol', source: 'vehicles', filter: ['==', ['get', 'hasHeading'], true], layout: { 'text-field': '▲', 'text-size': 12, 'text-offset': [0, -2], 'text-rotate': ['get', 'heading'], 'text-rotation-alignment': 'map', 'text-allow-overlap': true }, paint: { 'text-color': '#006b5e', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } })
      setError(false)
      // A style reload replaces all sources; force the latest data effects to run again.
      setReady(false)
      window.requestAnimationFrame(() => { if (mapRef.current === map) setReady(true) })
    })
    const userMove = (event: { originalEvent?: unknown }) => { if (event.originalEvent) latest.current.onCameraModeChange('free') }
    map.on('dragstart', userMove)
    map.on('zoomstart', userMove)
    const select = (event: maplibregl.MapLayerMouseEvent) => {
      const stopLayers = ['stop-hit-target'].filter(id => map.getLayer(id))
      if (stopLayers.length && map.queryRenderedFeatures(event.point, { layers: stopLayers }).length) return
      const index = event.features?.[0]?.properties?.legIndex
      if (typeof index === 'number') latest.current.onSelectLeg(index)
    }
    map.on('click', 'route-transit', select)
    map.on('click', 'route-walk', select)
    const showStop = (event: maplibregl.MapLayerMouseEvent, pinned: boolean) => {
      let label: string | undefined
      let distance = Infinity
      for (const feature of event.features ?? []) {
        if (feature.geometry.type !== 'Point' || typeof feature.properties?.label !== 'string') continue
        const position = map.project(feature.geometry.coordinates as [number, number])
        const delta = Math.hypot(position.x - event.point.x, position.y - event.point.y)
        if (delta < distance) { distance = delta; label = feature.properties.label }
      }
      if (label === undefined) return
      setStopCallout(current => !pinned && current?.pinned ? current : { label: label!, x: event.point.x, y: event.point.y, pinned })
    }
    const hoverStop = (event: maplibregl.MapLayerMouseEvent) => {
      if (window.matchMedia('(hover: hover)').matches) showStop(event, false)
    }
    const leaveStop = () => setStopCallout(current => current?.pinned ? current : null)
    const clickStop = (event: maplibregl.MapLayerMouseEvent) => showStop(event, true)
    map.on('mousemove', 'stop-hit-target', hoverStop)
    map.on('mouseleave', 'stop-hit-target', leaveStop)
    map.on('click', 'stop-hit-target', clickStop)
    map.on('click', event => {
      const layers = ['stop-hit-target'].filter(id => map.getLayer(id))
      if (!layers.length || !map.queryRenderedFeatures(event.point, { layers }).length) setStopCallout(null)
    })
    return () => { mapRef.current = null; map.remove() }
  }, [])

  useEffect(() => { setStopCallout(null) }, [scene.journey?.id])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setStopCallout(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])
  useEffect(() => {
    const node = stopRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setStopHeight(node.getBoundingClientRect().height))
    observer.observe(node)
    return () => observer.disconnect()
  }, [stopCallout, sizeVersion])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    ;(map.getSource('routes') as GeoJSONSource | undefined)?.setData(geometry?.routes ?? collection([]))
    ;(map.getSource('stops') as GeoJSONSource | undefined)?.setData(geometry?.stops ?? collection([]))
    const endpoints: MapFeature[] = []
    const origin = scene.origin?.coordinate ?? (scene.journey?.legs[0]?.from ? { lat: scene.journey.legs[0].from.lat, lon: scene.journey.legs[0].from.lon } : undefined)
    const last = scene.journey?.legs[scene.journey.legs.length - 1]?.to
    const destination = scene.destination?.coordinate ?? (last ? { lat: last.lat, lon: last.lon } : undefined)
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) endpoints.push(point(origin.lon, origin.lat, { letter: 'A', label: scene.origin?.name ?? scene.journey?.legs[0]?.from.name ?? '' }))
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lon)) endpoints.push(point(destination.lon, destination.lat, { letter: 'B', label: scene.destination?.name ?? last?.name ?? '' }))
    ;(map.getSource('endpoints') as GeoJSONSource | undefined)?.setData(collection(endpoints))
  }, [ready, geometry, scene.origin, scene.destination, scene.journey])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const vehicles = scene.vehicles.flatMap(vehicle => {
      const status = positionStatus(vehicle.observedAt, scene.observationNowMs)
      if (status === 'missing' || !Number.isFinite(vehicle.coordinate.lon) || !Number.isFinite(vehicle.coordinate.lat)) return []
      return [point(vehicle.coordinate.lon, vehicle.coordinate.lat, { label: `${vehicle.mode === 'TRAM' ? 'T' : 'B'} ${vehicle.lineDisplay}`, heading: vehicle.heading ?? 0, hasHeading: vehicle.heading !== undefined, stale: status === 'stale', primary: vehicle.id === scene.eligibleVehicleId && scene.liveStatus === 'live' && status === 'fresh' })]
    })
    ;(map.getSource('vehicles') as GeoJSONSource | undefined)?.setData(collection(vehicles))
    ;(map.getSource('location') as GeoJSONSource | undefined)?.setData(collection(location))
  }, [ready, scene.vehicles, scene.observationNowMs, scene.eligibleVehicleId, scene.liveStatus, location])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const resize = () => { mapRef.current?.resize(); setSizeVersion(value => value + 1) }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize) }
  }, [])

  useEffect(() => {
    const element = container.current
    const attribution = element?.querySelector('.maplibregl-ctrl-bottom-right')
    if (!ready || !element || !attribution) return
    const measure = () => {
      const bounds = element.getBoundingClientRect(), box = attribution.getBoundingClientRect()
      setAttributionBand(Math.max(8, bounds.bottom - visibleInsets(element, occlusion).bottom - box.top + 8))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(attribution)
    measure()
    return () => observer.disconnect()
  }, [ready, occlusion.bottom, sizeVersion])
  useEffect(() => {
    const node = statusRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setStatusHeight(node.getBoundingClientRect().height))
    observer.observe(node)
    return () => observer.disconnect()
  }, [sizeVersion, occlusion.left, occlusion.right, occlusion.top, occlusion.bottom])
  useEffect(() => {
    const node = controlsRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setControlsHeight(node.getBoundingClientRect().height))
    observer.observe(node)
    return () => observer.disconnect()
  }, [sizeVersion, occlusion.left, occlusion.right, occlusion.top, occlusion.bottom])

  const primary = scene.liveStatus === 'live' ? scene.vehicles.find(vehicle => vehicle.id === scene.eligibleVehicleId && Number.isFinite(vehicle.coordinate.lat) && Number.isFinite(vehicle.coordinate.lon) && positionStatus(vehicle.observedAt, scene.observationNowMs) === 'fresh') : undefined
  useEffect(() => {
    const map = mapRef.current, element = container.current
    if (!ready || error || !map || !element || !primary) { setVehiclePlacement(null); return }
    let frame = 0
    const update = () => {
      frame = 0
      const bounds = element.getBoundingClientRect()
      const inset = visibleInsets(element, occlusion)
      const rect = { left: inset.left, top: inset.top, right: bounds.width - inset.right, bottom: bounds.height - inset.bottom }
      const status = statusRef.current?.getBoundingClientRect()
      const controls = controlsRef.current?.getBoundingClientRect()
      const attrib = element.querySelector('.maplibregl-ctrl-bottom-right')?.getBoundingClientRect()
      if (status?.height && statusRef.current && getComputedStyle(statusRef.current).visibility !== 'hidden') rect.top = Math.max(rect.top, status.bottom - bounds.top + 8)
      if (controls?.height && controlsRef.current && getComputedStyle(controlsRef.current).visibility !== 'hidden') rect.bottom = Math.min(rect.bottom, controls.top - bounds.top - 8)
      if (attrib?.height) rect.bottom = Math.min(rect.bottom, attrib.top - bounds.top - 8)
      const badge = badgeRef.current?.getBoundingClientRect()
      if (!badge || rect.right - rect.left < badge.width + 16 || rect.bottom - rect.top < badge.height + 16) { setVehiclePlacement(null); return }
      const target = map.project([primary.coordinate.lon, primary.coordinate.lat])
      const inside = target.x >= rect.left + badge.width / 2 + 8 && target.x <= rect.right - badge.width / 2 - 8 && target.y >= rect.top + badge.height / 2 + 8 && target.y <= rect.bottom - badge.height / 2 - 8
      const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2
      const rayTarget = { x: cx + (target.x - cx) * 10000, y: cy + (target.y - cy) * 10000 }
      const edge = inside ? null : placeEdgeIndicator(rayTarget, rect, { width: badge.width, height: badge.height })
      const next = inside ? { x: target.x, y: target.y, angleDeg: 0, edge: false } : edge && { ...edge, edge: true }
      setVehiclePlacement(old => old?.x === next?.x && old?.y === next?.y && old?.angleDeg === next?.angleDeg && old?.edge === next?.edge ? old : next)
    }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update) }
    const observer = new ResizeObserver(schedule)
    for (const node of [element, statusRef.current, controlsRef.current, badgeRef.current, element.querySelector('.maplibregl-ctrl-bottom-right')]) if (node) observer.observe(node)
    map.on('move', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    schedule()
    return () => { if (frame) cancelAnimationFrame(frame); observer.disconnect(); map.off('move', schedule); window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule) }
  }, [ready, error, primary, occlusion.left, occlusion.right, occlusion.top, occlusion.bottom, sizeVersion, statusHeight, controlsHeight, attributionBand])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || cameraMode !== 'overview') return
    const bounds = new maplibregl.LngLatBounds()
    const current = latest.current
    const built = current.scene.journey ? buildJourneyFeatures(current.scene.journey, current.scene.selectedLegIndex) : null
    const selectedRoutes = built?.routes.features.filter(feature => current.scene.selectedLegIndex === null || feature.properties.selected) ?? []
    selectedRoutes.forEach(feature => feature.geometry.coordinates.forEach(coordinate => bounds.extend(coordinate as [number, number])))
    if (current.scene.selectedLegIndex === null || selectedRoutes.length === 0) {
      const first = current.scene.journey?.legs[0]?.from, last = current.scene.journey?.legs[current.scene.journey.legs.length - 1]?.to
      const coords = [current.scene.origin?.coordinate ?? (first && { lat: first.lat, lon: first.lon }), current.scene.destination?.coordinate ?? (last && { lat: last.lat, lon: last.lon })]
      coords.forEach(coord => { if (coord && Number.isFinite(coord.lat) && Number.isFinite(coord.lon)) bounds.extend([coord.lon, coord.lat]) })
      const fix = current.locationFix
      if (fix && Date.now() - fix.capturedAt <= 30000 && fix.accuracyM <= 100 && isInGraz(fix.coordinate)) bounds.extend([fix.coordinate.lon, fix.coordinate.lat])
    }
    if (bounds.isEmpty()) {
      if (!current.scene.journey) map.jumpTo({ center: [GRAZ_CENTER.lon, GRAZ_CENTER.lat], zoom: 12 })
      return
    }
    const width = map.getContainer().clientWidth, height = map.getContainer().clientHeight
    const clamp = (value: number, available: number) => Math.max(0, Math.min(value + 24, Math.max(0, available)))
    const horizontal = Math.max(0, width - 120), vertical = Math.max(0, height - 120)
    const left = clamp(current.occlusion.left, horizontal / 2), right = clamp(current.occlusion.right, horizontal - left)
    const top = clamp(current.occlusion.top, vertical / 2), bottom = clamp(current.occlusion.bottom, vertical - top)
    map.fitBounds(bounds, { padding: { top, right, bottom, left }, maxZoom: 16, duration: 0 })
  }, [ready, cameraMode, scene.journey?.id, scene.selectedLegIndex, overviewRequest, sizeVersion, occlusion.top, occlusion.right, occlusion.bottom, occlusion.left])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    if (cameraMode === 'follow-user' && usableFix && locationFix) map.easeTo({ center: [locationFix.coordinate.lon, locationFix.coordinate.lat], zoom: 16, duration: 0 })
    if (cameraMode === 'follow-vehicle' && following) { const inset = visibleInsets(container.current, occlusion); map.easeTo({ center: [following.coordinate.lon, following.coordinate.lat], offset: [(inset.left - inset.right) / 2, (inset.top - inset.bottom) / 2], duration: 0 }) }
    if (cameraMode === 'follow-vehicle' && !following) { setFollowPaused(true); props.onCameraModeChange('free') }
  }, [ready, cameraMode, usableFix, locationFix, following?.coordinate.lat, following?.coordinate.lon, followVehicleId, props.onCameraModeChange, occlusion.left, occlusion.right, occlusion.top, occlusion.bottom])

  const locate = async () => {
    const fix = await props.onRequestLocation()
    if (fix && fix.accuracyM <= 100 && Date.now() - fix.capturedAt <= 30000 && isInGraz(fix.coordinate)) {
      mapRef.current?.easeTo({ center: [fix.coordinate.lon, fix.coordinate.lat], zoom: 16, duration: 0 })
      props.onCameraModeChange('follow-user')
    }
  }
  const centerOnPrimary = () => {
    const map = mapRef.current, current = latest.current
    const vehicle = current.scene.vehicles.find(item => item.id === current.scene.eligibleVehicleId)
    if (!map || current.scene.liveStatus !== 'live' || !vehicle || !Number.isFinite(vehicle.coordinate.lon) || !Number.isFinite(vehicle.coordinate.lat) || positionStatus(vehicle.observedAt, current.scene.observationNowMs) !== 'fresh') return
    current.onCameraModeChange('free')
    const inset = visibleInsets(container.current, current.occlusion)
    map.easeTo({ center: [vehicle.coordinate.lon, vehicle.coordinate.lat], zoom: 16, pitch: 0, bearing: 0, offset: [(inset.left - inset.right) / 2, (inset.top - inset.bottom) / 2], duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180 })
  }
  const locationLabel = de ? 'Mein Standort' : 'My location'
  const width = container.current?.clientWidth ?? 0
  const height = container.current?.clientHeight ?? 0
  const inset = visibleInsets(container.current, occlusion)
  const freeWidth = Math.max(0, width - inset.left - inset.right)
  const freeHeight = Math.max(0, height - inset.top - inset.bottom)
  const showFloating = freeWidth >= 64 && freeHeight >= 64
  const showControls = freeWidth >= 64 && freeHeight >= attributionBand + controlsHeight + 24 + statusHeight
  const locationError = locationStatus === 'denied' || locationStatus === 'unavailable' || locationStatus === 'outside'
  return <section className={`transit-map${occlusion.bottom > 0 && occlusion.bottom >= (container.current?.clientHeight ?? Infinity) * 0.8 ? ' transit-map--expanded' : ''}`} aria-label={de ? 'Karte der Fahrt' : 'Journey map'} style={{ '--map-bottom-occlusion': `${Math.max(0, inset.bottom)}px` } as CSSProperties}>
    <div className="transit-map__canvas" ref={container} />
    {showFloating && <div ref={statusRef} className="transit-map__status-stack" style={{ left: inset.left + 8, top: inset.top + 8, maxWidth: Math.max(0, freeWidth - 16), visibility: statusHeight + attributionBand + 16 <= freeHeight ? 'visible' : 'hidden' }}>
      {error && <div role="status">{translate(locale, 'mapUnavailable')}</div>}
      {followPaused && <div role="status">{de ? 'Fahrzeugverfolgung pausiert.' : 'Vehicle following paused.'}</div>}
      {geometry && geometry.unavailableLegIndices.length > 0 && <div role="status">{de ? 'Linienverlauf für diesen Abschnitt nicht verfügbar.' : 'Route geometry unavailable for this segment.'}</div>}
      {scene.liveStatus !== 'idle' && <div role="status">{primary && <strong>{primary.lineDisplay} → {primary.targetName} · </strong>}{translate(locale, scene.liveStatus === 'live' ? scene.vehicleSelection === 'pinned' ? 'selectedObservation' : 'likelyVehicle' : scene.liveStatus === 'loading' ? 'liveLoading' : scene.liveStatus === 'ambiguous' ? 'liveAmbiguous' : 'liveUnavailable')}</div>}
      {locationError ? <div role="status">{locationStatus === 'denied' ? (de ? 'Standortzugriff verweigert.' : 'Location permission denied.') : locationStatus === 'outside' ? (de ? 'Standort außerhalb von Graz.' : 'Location outside Graz.') : translate(locale, 'locationUnavailable')}</div> : locationFix && location.length > 0 && <div className="transit-map__location-row" role="status"><span className="transit-map__location-dot" /><span><strong>{translate(locale, clock - locationFix.capturedAt > 30000 || locationFix.capturedAt > clock + 5000 ? 'lastKnownLocation' : 'yourLocation')}</strong><small>{translate(locale, 'locationAccuracy')} · ±{Math.round(locationFix.accuracyM)} m</small></span></div>}
    </div>}
    {showFloating && <div ref={controlsRef} className="transit-map__controls" style={{ bottom: `${inset.bottom + attributionBand}px`, right: `${inset.right + 8}px`, visibility: showControls ? 'visible' : 'hidden' }}>
      <button className="transit-map__overview" type="button" onClick={() => { props.onOverview(); setOverviewRequest(value => value + 1) }} aria-pressed={cameraMode === 'overview'}>{de ? 'Gesamte Route' : 'Whole route'}</button>
      <button type="button" onClick={locate} title={locationLabel} aria-label={locationLabel} aria-pressed={cameraMode === 'follow-user'} disabled={locationStatus === 'locating'}><Icon name="my_location" /> <span className="transit-map__control-label">{locationLabel}</span></button>
    </div>}
    {primary && <button ref={badgeRef} className={`transit-map__vehicle${vehiclePlacement?.edge ? ' transit-map__vehicle--edge' : ''}`} type="button" onClick={centerOnPrimary} title={`${translate(locale, vehiclePlacement?.edge ? 'showLivePosition' : scene.vehicleSelection === 'pinned' ? 'selectedObservation' : 'likelyVehicle')} · ${primary.lineDisplay} → ${primary.targetName} · ${Math.max(0, Math.floor((scene.observationNowMs - primary.observedAt) / 1000))} s`} aria-label={`${translate(locale, vehiclePlacement?.edge ? 'showLivePosition' : scene.vehicleSelection === 'pinned' ? 'selectedObservation' : 'likelyVehicle')} · ${primary.lineDisplay} → ${primary.targetName} · ${Math.max(0, Math.floor((scene.observationNowMs - primary.observedAt) / 1000))} s`} style={{ left: vehiclePlacement?.x ?? 0, top: vehiclePlacement?.y ?? 0, visibility: vehiclePlacement && showFloating ? 'visible' : 'hidden' }}><Icon name={primary.mode === 'TRAM' ? 'tram' : 'directions_bus'} /><strong>{primary.lineDisplay}</strong><span className="transit-map__vehicle-arrow" style={{ transform: `rotate(${vehiclePlacement?.angleDeg ?? 0}deg)`, visibility: vehiclePlacement?.edge ? 'visible' : 'hidden' }}><Icon name="navigation" /></span></button>}
    {stopCallout && showFloating && <div ref={stopRef} role={stopCallout.pinned ? 'status' : 'tooltip'} className={`transit-map__stop-callout${stopCallout.pinned ? '' : ' transit-map__stop-callout--hover'}`} style={{ maxWidth: freeWidth - 16, maxHeight: freeHeight - 16, left: Math.max(inset.left + 8, Math.min(stopCallout.x, width - inset.right - Math.min(240, freeWidth - 16) - 8)), top: Math.max(inset.top + 8, Math.min(stopCallout.y, height - inset.bottom - stopHeight - 8)) }}><strong>{stopCallout.label}</strong>{stopCallout.pinned && <button type="button" onClick={() => setStopCallout(null)}>{translate(locale, 'close')}</button>}</div>}
  </section>
}
