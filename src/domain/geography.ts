import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import type { FeatureCollection, Polygon } from 'geojson'
import boundaryJson from '../data/graz-boundary.geojson?raw'
import { GRAZ_EXTENT } from '../config'
import type { Coordinate } from './types'

// Datenquelle: Stadt Graz – data.graz.gv.at, OGD Stadtgrenze layer 12.
// Redistribution terms must be resolved before public release.
const boundary = JSON.parse(boundaryJson) as FeatureCollection<Polygon>

export function isInGraz(coordinate: Coordinate): boolean {
  const { lat, lon } = coordinate
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lon < GRAZ_EXTENT.west || lon > GRAZ_EXTENT.east || lat < GRAZ_EXTENT.south || lat > GRAZ_EXTENT.north) return false
  return boundary.features.some((feature) => booleanPointInPolygon(point([lon, lat]), feature))
}
