export const TRANSITOUS_API_BASE = 'https://api.transitous.org/api'
export const OPEN_TRAFFIC_MAP_SOCKET = 'wss://opentrafficmap.org/ws_tiled'
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
export const GRAZ_CENTER = { lat: 47.0707, lon: 15.4395 } as const
export const GRAZ_EXTENT = {
  west: 15.349171800035792,
  south: 47.01099856381888,
  east: 15.535504642151956,
  north: 47.135508816624096,
} as const
export const VIENNA_TIME_ZONE = 'Europe/Vienna'
export const REPOSITORY_URL = import.meta.env.VITE_REPOSITORY_URL?.trim() || undefined
export const ISSUES_URL = REPOSITORY_URL ? `${REPOSITORY_URL.replace(/\/+$/, '')}/issues` : undefined
