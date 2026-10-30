import polyline from '@mapbox/polyline'
import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import type { Journey, Place } from './types'

export type RouteProperties = { legIndex: number; mode: string; selected: boolean; walk: boolean; label: string }
export type StopProperties = { legIndex: number; label: string; board: boolean; alight: boolean; transfer: boolean; intermediate: boolean; selected: boolean }
export type JourneyFeatures = {
  routes: FeatureCollection<LineString, RouteProperties>
  stops: FeatureCollection<Point, StopProperties>
  unavailableLegIndices: number[]
}

const valid = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180

/** Decode each leg independently, retaining usable geometry and merging coincident stop roles. */
export function buildJourneyFeatures(journey: Journey, selectedLegIndex: number | null): JourneyFeatures {
  const routes: Feature<LineString, RouteProperties>[] = []
  const stops: Feature<Point, StopProperties>[] = []
  const unavailableLegIndices: number[] = []
  const byId = new Map<string, Feature<Point, StopProperties>>()
  const byCoordinate = new Map<string, Feature<Point, StopProperties>>()
  const addStop = (place: Place, legIndex: number, role: 'board' | 'alight' | 'intermediate') => {
    if (!valid(place.lat, place.lon)) return
    const key = `${place.lon},${place.lat}`
    let feature = (place.stopId && byId.get(place.stopId)) || byCoordinate.get(key)
    if (!feature) {
      feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [place.lon, place.lat] }, properties: { legIndex, label: place.name, board: false, alight: false, transfer: false, intermediate: false, selected: false } }
      stops.push(feature)
    }
    if (place.stopId) byId.set(place.stopId, feature)
    byCoordinate.set(key, feature)
    feature.properties[role] = true
    feature.properties.transfer = feature.properties.board && feature.properties.alight
    if (selectedLegIndex === null || legIndex === selectedLegIndex) { feature.properties.selected = true; if (legIndex === selectedLegIndex) feature.properties.legIndex = legIndex }
  }
  journey.legs.forEach((leg, legIndex) => {
    try {
      const geometry = leg.legGeometry
      if (!geometry || typeof geometry.points !== 'string' || !geometry.points || !Number.isInteger(geometry.precision) || geometry.precision < 0 || geometry.precision > 10) throw new Error('Invalid geometry')
      const coordinates = polyline.decode(geometry.points, geometry.precision).map(([lat, lon]) => {
        if (!valid(lat, lon)) throw new Error('Invalid coordinate')
        return [lon, lat]
      })
      if (coordinates.length < 2) throw new Error('Short geometry')
      routes.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { legIndex, mode: leg.mode, selected: selectedLegIndex === null || selectedLegIndex === legIndex, walk: leg.mode === 'WALK', label: leg.mode === 'WALK' ? '' : leg.routeShortName } })
    } catch { unavailableLegIndices.push(legIndex) }
    if (leg.mode !== 'WALK') {
      addStop(leg.from, legIndex, 'board')
      addStop(leg.to, legIndex, 'alight')
      leg.intermediateStops?.forEach(stop => addStop(stop, legIndex, 'intermediate'))
    }
  })
  return { routes: { type: 'FeatureCollection', features: routes }, stops: { type: 'FeatureCollection', features: stops }, unavailableLegIndices }
}
