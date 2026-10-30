import { describe, expect, it } from 'vitest'
import boundaryJson from '../data/graz-boundary.geojson?raw'
import { isInGraz } from './geography'

describe('isInGraz', () => {
  it('includes central Graz and excludes Vienna', () => {
    expect(isInGraz({ lat: 47.0707, lon: 15.4395 })).toBe(true)
    expect(isInGraz({ lat: 48.2082, lon: 16.3738 })).toBe(false)
  })

  it('includes an exact point on the official boundary', () => {
    const boundary = JSON.parse(boundaryJson) as { features: { geometry: { coordinates: number[][][] } }[] }
    const [lon, lat] = boundary.features[0].geometry.coordinates[0][0]
    expect(isInGraz({ lat, lon })).toBe(true)
  })

  it('rejects non-finite coordinates', () => {
    expect(isInGraz({ lat: NaN, lon: 15.44 })).toBe(false)
  })
})
