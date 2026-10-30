export type Locale = 'de' | 'en'
export type Coordinate = { lat: number; lon: number }
export type LocationFix = { coordinate: Coordinate; accuracyM: number; capturedAt: number }
export type PositionStatus = 'fresh' | 'stale' | 'missing'
export type TransitMode = 'BUS' | 'TRAM'
export type PlaceKind = 'STOP' | 'ADDRESS'
export type PlaceSearchMode = 'ALL' | PlaceKind

export type PlaceSearchResult = { choices: PlaceChoice[]; incomplete: boolean }

export interface PlaceChoice {
  kind: PlaceKind
  name: string
  coordinate: Coordinate
  stopId?: string
  subtitle?: string
  street?: string
  houseNumber?: string
}

// Consumed MOTIS v2.10.2 fields retain their provider names and timestamp strings.
export interface Place {
  name: string
  lat: number
  lon: number
  stopId?: string
  parentId?: string
  arrival?: string
  departure?: string
  scheduledArrival?: string
  scheduledDeparture?: string
  arrivalTimestampReason?: string
  departureTimestampReason?: string
  track?: string
  scheduledTrack?: string
  stopCode?: string
  pickupType?: 'NORMAL' | 'NOT_ALLOWED'
  dropoffType?: 'NORMAL' | 'NOT_ALLOWED'
  cancelled?: boolean
}

export interface EncodedPolyline {
  points: string
  precision: number
  length: number
}

export interface StepInstruction {
  distance?: number
  streetName?: string
  relativeDirection?: string
  absoluteDirection?: string
  exit?: string
  lat?: number
  lon?: number
}

export interface LegBase {
  startTime: string
  endTime: string
  scheduledStartTime: string
  scheduledEndTime: string
  realTime: boolean
  scheduled: boolean
  duration: number
  from: Place
  to: Place
  legGeometry: EncodedPolyline
  departureTimestampReason?: string
  arrivalTimestampReason?: string
}

export interface WalkingLeg extends LegBase {
  mode: 'WALK'
  distance?: number
  steps?: StepInstruction[]
}

export interface TransitLeg extends LegBase {
  mode: TransitMode
  tripId: string
  routeId: string
  directionId: string
  routeShortName: string
  headsign: string
  tripFrom?: Place
  tripTo?: Place
  intermediateStops?: Place[]
  interlineWithPreviousLeg?: boolean
  cancelled?: boolean
  displayName?: string
}

export type Leg = WalkingLeg | TransitLeg
export interface Journey {
  id: string
  duration: number
  startTime: string
  endTime: string
  transfers: number
  legs: Leg[]
}

export interface Departure {
  place: Place
  mode: TransitMode
  realTime: boolean
  headsign: string
  tripFrom: Place
  tripTo: Place
  tripId: string
  routeId: string
  directionId: string
  routeShortName: string
  displayName: string
  pickupDropoffType: 'NORMAL' | 'NOT_ALLOWED'
  cancelled: boolean
  tripCancelled: boolean
  nextStops?: Place[]
}

// A full trip uses the provider's transit leg shape, including ordered intermediate stops.
export type TransitTrip = TransitLeg
export interface JourneyQuery {
  origin: PlaceChoice
  destination: PlaceChoice
  timeMs: number
  locale: Locale
  walkingSpeed: number
  pageCursor?: string
}
export type DepartureQuery = {
  timeMs: number
  locale: Locale
  pageCursor?: string
} & ({ stopId: string; center?: never; radius?: never } | { stopId?: never; center: Coordinate; radius: number })
export interface JourneyPage {
  journeys: Journey[]
  nextPageCursor?: string
  previousPageCursor?: string
}
export interface DeparturePage {
  departures: Departure[]
  nextPageCursor?: string
  previousPageCursor?: string
}
