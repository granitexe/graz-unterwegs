import type { Journey } from '../domain/types'

export interface JourneyState {
  journey: Journey | null
  selectedLegIndex: number | null
  pinnedVehicleId: string | null
}

export type JourneyAction =
  | { type: 'select'; journey: Journey }
  | { type: 'select-leg'; index: number | null }
  | { type: 'refresh'; journey: Journey }
  | { type: 'pin'; vehicleId: string | null }
  | { type: 'expire-pin' | 'reset' }

export const initialJourneyState: JourneyState = {
  journey: null, selectedLegIndex: null, pinnedVehicleId: null,
}

/** Refreshes may update events, but must not change the selected itinerary or trip identities. */
function sameItinerary(current: Journey, next: Journey): boolean {
  return current.id === next.id && current.legs.length === next.legs.length && current.legs.every((leg, index) => {
    const other = next.legs[index]
    return leg.mode === other.mode &&
      leg.from.stopId === other.from.stopId && leg.to.stopId === other.to.stopId &&
      (leg.mode === 'WALK'
        ? other.mode === 'WALK' && leg.from.lat === other.from.lat && leg.from.lon === other.from.lon && leg.to.lat === other.to.lat && leg.to.lon === other.to.lon
        : other.mode !== 'WALK' && leg.tripId === other.tripId)
  })
}

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyState {
  switch (action.type) {
    case 'select':
      return { journey: action.journey, selectedLegIndex: null, pinnedVehicleId: null }
    case 'select-leg':
      if (!state.journey || (action.index !== null && (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.journey.legs.length))) return state
      if (action.index === state.selectedLegIndex) return state
      return { ...state, selectedLegIndex: action.index, pinnedVehicleId: null }
    case 'refresh':
      return state.journey && sameItinerary(state.journey, action.journey) ? { ...state, journey: action.journey } : state
    case 'pin':
      return state.journey ? { ...state, pinnedVehicleId: action.vehicleId } : state
    case 'expire-pin':
      return state.pinnedVehicleId === null ? state : { ...state, pinnedVehicleId: null }
    case 'reset':
      return initialJourneyState
  }
}
