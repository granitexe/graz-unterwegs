import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities'
import type { Journey, JourneyQuery, Locale, PlaceChoice } from './domain/types'
import { JourneySearch } from './components/JourneySearch'
import JourneyNavigation from './components/JourneyNavigation'
import DeparturesView from './components/DeparturesView'
import TransitMap, { type CameraMode, type MapScene } from './components/TransitMap'
import { LocationProvider, useLocation } from './state/location'
import { initialJourneyState, journeyReducer } from './state/journey'
import { Icon } from './components/Icon'


type View = 'plan' | 'journey' | 'departures' | 'about'

const copy = {
  de: {
    journey: 'Fahrt', departures: 'Abfahrten', about: 'Über diese App', language: 'Sprache',
    planTitle: 'Deine Fahrt durch Graz', planText: 'Plane deine Verbindung mit Bus und Straßenbahn in Graz.',
    departuresTitle: 'Abfahrten in Graz', departuresText: 'Entdecke Abfahrten und Fahrtrichtungen an einer Haltestelle.',
    journeyMissing: 'Es ist keine Fahrt ausgewählt. Bitte plane zuerst eine Verbindung.',
    aboutTitle: 'Über Graz unterwegs', independent: 'Graz unterwegs ist ein unabhängiges Projekt und steht nicht in Verbindung mit Graz Linien oder OpenTrafficMap.',
    sources: 'Datenquellen und Karten', privacy: 'Datenschutz', privacyText: 'Für die Verbindungssuche werden Start und Ziel an Transitous gesendet. Kartenanfragen gehen an OpenFreeMap. Dein Standort wird nicht an OpenTrafficMap gesendet. Es gibt keine Analysewerkzeuge und keinen Standortverlauf. Die Spracheinstellung wird lokal gespeichert.',
    code: 'Quellcode und Kontakt', local: 'Lokale Entwicklung', contact: 'Kontakt über GitHub Issues', licence: 'Der ursprüngliche Anwendungscode steht unter der MIT-Lizenz. Für Daten, Schrift und Symbole gelten eigene Bedingungen.',
    terms: 'Für eine öffentliche Veröffentlichung müssen die Nutzungsbedingungen der OpenTrafficMap-Daten und der Grazer Stadtgrenze geklärt werden.',
    navigation: 'Hauptnavigation', sourceCode: 'Quellcode',
  },
  en: {
    journey: 'Journey', departures: 'Departures', about: 'About', language: 'Language',
    planTitle: 'Your journey through Graz', planText: 'Plan your bus and tram journey in Graz.',
    departuresTitle: 'Departures in Graz', departuresText: 'Explore departures and directions at a stop.',
    journeyMissing: 'No journey is selected. Please plan a connection first.',
    aboutTitle: 'About Graz unterwegs', independent: 'Graz unterwegs is an independent project and is not affiliated with Graz Linien or OpenTrafficMap.',
    sources: 'Data sources and maps', privacy: 'Privacy', privacyText: 'Journey searches send your origin and destination to Transitous. Map requests go to OpenFreeMap. Your location is not sent to OpenTrafficMap. There is no analytics or location history. Your language preference is stored locally.',
    code: 'Source code and contact', local: 'Local development', contact: 'Contact via GitHub Issues', licence: 'Original application code is licensed under MIT. Data, fonts and icons have their own terms.',
    terms: 'Public release requires the terms for OpenTrafficMap data and the Graz city boundary to be resolved.',
    navigation: 'Main navigation', sourceCode: 'Source code',
  },
} as const

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem('graz-transit-locale')
    if (saved === 'de' || saved === 'en') return saved
  } catch { /* Storage can be unavailable. */ }
  for (const language of navigator.languages || [navigator.language]) {
    const primary = language.toLowerCase().split('-')[0]
    if (primary === 'de' || primary === 'en') return primary
  }
  return 'en'
}

function applyColors(dark: boolean) {
  const theme = themeFromSourceColor(argbFromHex('#006B5E'))
  const scheme = dark ? theme.schemes.dark : theme.schemes.light
  const colors = {
    primary: scheme.primary, 'on-primary': scheme.onPrimary,
    'primary-container': scheme.primaryContainer, 'on-primary-container': scheme.onPrimaryContainer,
    surface: scheme.surface, 'on-surface': scheme.onSurface,
    'surface-variant': scheme.surfaceVariant, 'on-surface-variant': scheme.onSurfaceVariant,
    outline: scheme.outline, 'secondary-container': scheme.secondaryContainer,
    'on-secondary-container': scheme.onSecondaryContainer,
    'surface-container': theme.palettes.neutral.tone(dark ? 10 : 96),
    'surface-container-high': theme.palettes.neutral.tone(dark ? 17 : 94),
    'outline-variant': scheme.outlineVariant, error: scheme.error,
    'on-error-container': scheme.onErrorContainer, 'error-container': scheme.errorContainer,
  }
  for (const [name, value] of Object.entries(colors)) {
    document.documentElement.style.setProperty(`--md-${name}`, hexFromArgb(value))
  }
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}


function readView(hasJourney: boolean): { view: View; missing: boolean } {
  const hash = window.location.hash
  if (hash === '#/journey') return hasJourney ? { view: 'journey', missing: false } : { view: 'plan', missing: true }
  if (hash === '#/departures') return { view: 'departures', missing: false }
  if (hash === '#/about') return { view: 'about', missing: false }
  return { view: 'plan', missing: false }
}

export default function App() {
  const [route, setRoute] = useState(() => readView(false))
  return <LocationProvider active={route.view !== 'about'}><Workspace route={route} setRoute={setRoute} /></LocationProvider>
}

function Workspace({ route, setRoute }: { route: { view: View; missing: boolean }; setRoute: (route: { view: View; missing: boolean }) => void }) {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const [selection, setSelection] = useState<{ journey: Journey; query: JourneyQuery } | null>(null)
  const [journeyState, dispatch] = useReducer(journeyReducer, initialJourneyState)
  const location = useLocation()
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview')
  const [followId, setFollowId] = useState<string | undefined>()
  const [trackingScene, setTrackingScene] = useState<MapScene | null>(null)
  const [departureScene, setDepartureScene] = useState<MapScene | null>(null)
  const [places, setPlaces] = useState<{ origin: PlaceChoice | null; destination: PlaceChoice | null }>({ origin: null, destination: null })
  const [initialDestination, setInitialDestination] = useState<PlaceChoice | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const [occlusion, setOcclusion] = useState({ top: 0, right: 0, bottom: 0, left: 0 })
  const [sheet, setSheet] = useState(60)
  const dragStart = useRef<number | null>(null)
  const dragged = useRef(false)
  useEffect(() => { setSheet(route.view === 'journey' ? 30 : 60); panelRef.current?.scrollTo(0, 0) }, [route.view])
  const publishPlaces = useCallback((origin: PlaceChoice | null, destination: PlaceChoice | null) => setPlaces({ origin, destination }), [])
  const emptyScene = useMemo<MapScene>(() => ({ journey: null, selectedLegIndex: null, origin: places.origin ?? undefined, destination: places.destination ?? undefined, vehicles: [], liveStatus: 'idle', vehicleSelection: null, observationNowMs: Date.now() }), [places])
  const scene = route.view === 'journey' ? trackingScene ?? emptyScene : route.view === 'departures' ? departureScene ?? emptyScene : emptyScene
  const follow = useCallback((id: string) => { if (scene.eligibleVehicleId === id) { setFollowId(id); setCameraMode('follow-vehicle') } }, [scene.eligibleVehicleId])
  const changeCameraMode = useCallback((mode: CameraMode) => { if (mode !== 'follow-vehicle') setFollowId(undefined); setCameraMode(mode) }, [])
  useEffect(() => {
    if (cameraMode === 'follow-vehicle' && (!followId || scene.eligibleVehicleId !== followId)) { setCameraMode('free'); setFollowId(undefined) }
  }, [cameraMode, followId, scene.eligibleVehicleId])
  useEffect(() => {
    const measure = () => {
      const map = workspaceRef.current?.getBoundingClientRect(), pane = panelRef.current?.getBoundingClientRect()
      if (!map || !pane) return
      const overlap = Math.max(0, Math.min(map.right, pane.right) - Math.max(map.left, pane.left))
      const height = Math.max(0, Math.min(map.bottom, pane.bottom) - Math.max(map.top, pane.top))
      setOcclusion(window.innerWidth < 840 ? { top: 0, right: 0, bottom: height, left: 0 } : { top: 0, right: 0, bottom: 0, left: overlap })
    }
    const observer = new ResizeObserver(measure)
    if (workspaceRef.current) observer.observe(workspaceRef.current)
    if (panelRef.current) observer.observe(panelRef.current)
    window.visualViewport?.addEventListener('resize', measure); window.visualViewport?.addEventListener('scroll', measure)
    measure()
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('scroll', measure) }
  }, [route.view])
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [initialOrigin, setInitialOrigin] = useState<PlaceChoice | null>(null)
  const [initialTimeMs, setInitialTimeMs] = useState<number | undefined>()
  const [searchVersion, setSearchVersion] = useState(0)
  const t = copy[locale]
  useEffect(() => {
    document.documentElement.lang = locale
    try { localStorage.setItem('graz-transit-locale', locale) } catch { /* Rendering does not depend on storage. */ }
  }, [locale])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => applyColors(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const update = () => {
      const next = readView(selectionRef.current !== null)
      if (next.missing) window.history.replaceState(null, '', '#/plan')
      setRoute(next)
    }
    if (window.location.hash === '#/journey' && !selectionRef.current) window.history.replaceState(null, '', '#/plan')
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  function navigate(view: View) {
    const hash = `#/${view}`
    if (window.location.hash !== hash) window.location.hash = hash
    setRoute({ view, missing: false })
  }

  function planFrom(origin: PlaceChoice, timeMs?: number) {
    setInitialOrigin(origin)
    setInitialDestination(null)
    setInitialTimeMs(timeMs)
    setSearchVersion(version => version + 1)
    navigate('plan')
  }

  const repository = import.meta.env.VITE_REPOSITORY_URL as string | undefined
  const repoUrl = repository && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repository) ? repository.replace(/\/$/, '') : undefined
  const links = [
    { view: 'plan', label: t.journey, icon: 'route' },
    { view: 'departures', label: t.departures, icon: 'departure_board' },
  ] as const

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#/plan"><Icon name="route" /><span>Graz unterwegs</span></a>
      <div className="header-actions">
        <a className="about-link" href="#/about" aria-label={t.about} aria-current={route.view === 'about' ? 'page' : undefined}><Icon name="info" /><span>{t.about}</span></a>
        <div className="language-switch" role="group" aria-label={t.language}>
          {(['de', 'en'] as const).map((option) => <button key={option} type="button" aria-pressed={locale === option} onClick={() => setLocale(option)}>{option.toUpperCase()}</button>)}
        </div>
      </div>
    </header>
    <nav className="primary-nav" aria-label={t.navigation}>
      {links.map((link) => <a key={link.view} href={`#/${link.view}`} aria-current={(route.view === link.view || (link.view === 'plan' && route.view === 'journey')) ? 'page' : undefined}><Icon name={link.icon} /><span>{link.label}</span></a>)}
    </nav>
    <main ref={workspaceRef} className="main-content main-content--workspace" id="main-content">
      <div className="workspace-map" hidden={route.view === 'about'}><TransitMap scene={scene} locale={locale} locationFix={location.fix} locationStatus={location.status} cameraMode={cameraMode} followVehicleId={followId} onCameraModeChange={changeCameraMode} onSelectLeg={index => { dispatch({ type: 'select-leg', index }); setCameraMode('overview') }} onRequestLocation={location.requestLocation} onOverview={() => { dispatch({ type: 'select-leg', index: null }); setCameraMode('overview') }} occlusion={occlusion} /></div>
      <div className="workspace-pane" ref={panelRef} hidden={route.view === 'about'} style={{ '--sheet-height': `${sheet}%` } as CSSProperties} onFocusCapture={event => { if (event.target instanceof HTMLInputElement && window.innerWidth < 840) setSheet(90) }}>
      <button className="workspace-sheet-handle" type="button" aria-label={locale === 'de' ? 'Bereich erweitern oder verkleinern' : 'Expand or collapse panel'} aria-expanded={sheet > 30} onPointerDown={event => { dragged.current = false; dragStart.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerUp={event => { if (dragStart.current !== null) { const delta = dragStart.current - event.clientY; if (Math.abs(delta) > 30) { dragged.current = true; setSheet(value => delta > 0 ? (value < 60 ? 60 : 90) : (value > 60 ? 60 : 30)) } dragStart.current = null } }} onClick={() => { if (!dragged.current) setSheet(value => value === 30 ? 60 : value === 60 ? 90 : 30) }}><span /></button>
      <div hidden={route.view !== 'plan'} className="planner-view">
        {route.missing && <p className="notice" role="status">{t.journeyMissing}</p>}
        <JourneySearch key={searchVersion} locale={locale} initialOrigin={initialOrigin} initialDestination={initialDestination} initialTimeMs={initialTimeMs} active={route.view === 'plan'} onPlacesChange={publishPlaces} onOriginLocationSelected={() => setCameraMode('follow-user')} onSelect={(journey, query) => {
          const next = { journey, query }
          selectionRef.current = next
          setSelection(next)
          dispatch({ type: 'select', journey })
          setTrackingScene({ journey, selectedLegIndex: null, origin: query.origin, destination: query.destination, vehicles: [], liveStatus: 'idle', vehicleSelection: null, observationNowMs: Date.now() })
          setFollowId(undefined); setCameraMode('overview')
          navigate('journey')
        }} />
      </div>
      {selection && <div hidden={route.view !== 'journey'}><JourneyNavigation state={journeyState} onAction={action => { dispatch(action); if (action.type === 'select-leg') setCameraMode('overview') }} query={selection.query} locale={locale} active={route.view === 'journey'} onBack={() => navigate('plan')} onFindNewConnection={() => {
        const fix = location.fix
        setInitialOrigin(fix && location.enabled && Date.now() - fix.capturedAt <= 30000 && fix.accuracyM <= 100 ? { kind: 'ADDRESS', name: locale === 'de' ? 'Mein Standort' : 'My location', coordinate: fix.coordinate } : selection.query.origin)
        setInitialDestination(selection.query.destination); setInitialTimeMs(undefined); setSearchVersion(version => version + 1); navigate('plan')
      }} onMapSceneChange={setTrackingScene} onFollowVehicle={follow} /></div>}
      <div hidden={route.view !== 'departures'}><DeparturesView locale={locale} active={route.view === 'departures'} onPlanFromStop={planFrom} onMapSceneChange={setDepartureScene} onFollowVehicle={follow} /></div>
      </div>
      {route.view === 'about' && <article className="content-card about-card">
        <h1>{t.aboutTitle}</h1><p>{t.independent}</p>
        <h2>{t.sources}</h2>
        <ul>
          <li><a href="https://transitous.org/sources/">Transitous Sources</a></li>
          <li><a href="https://wiki.opentrafficmap.org/">OpenTrafficMap</a></li>
          <li><a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://openmaptiles.org/">OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a></li>
          <li><a href="https://data.graz.gv.at/">Datenquelle: Stadt Graz – data.graz.gv.at</a></li>
          <li><a href="https://data.mobilitaetsverbuende.at/">Data source: Mobilitätsverbünde Österreich OG - data.mobilitaetsverbuende.at</a></li>
        </ul>
        <p>{t.terms}</p>
        <h2>{t.privacy}</h2><p>{t.privacyText}</p>
        <h2>{t.code}</h2><p>{repoUrl ? <><a href={repoUrl}>{t.sourceCode}</a> · <a href={`${repoUrl}/issues`}>{t.contact}</a></> : t.local}</p><p>{t.licence}</p>
        <p><a href={`${import.meta.env.BASE_URL}icons/LICENSE`}>Material Symbols / Material Icons: Apache-2.0</a> · <a href={`${import.meta.env.BASE_URL}ROBOTO-LICENSE`}>Roboto: OFL-1.1</a> · <a href={`${import.meta.env.BASE_URL}THIRD-PARTY-NOTICES.txt`}>Notices</a></p>
      </article>}
    </main>
  </div>
}
