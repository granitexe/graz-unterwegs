# Graz unterwegs

An independent, bilingual Graz bus and tram journey planner with departures and observed vehicle positions. It is not affiliated with Graz Linien or OpenTrafficMap. Timetable predictions and vehicle observations are not guarantees: vehicle coverage can be absent, and a likely vehicle match is not a verified trip identity.

Search combines stops and addresses within Graz; choose a suggestion explicitly before requesting a connection. Selecting a connection opens its full route and timetable immediately. Segment inspection and likely vehicle observations do not assert that a traveller has boarded. Location is optional, held only in memory, and followed only after an explicit request.

The map shows known stops only between each selected boarding and alighting point. Live positions represent compatible observations, not confirmed vehicle identities; an ambiguous observation must be selected explicitly. The directional chip recentres the map once, while following a vehicle remains a separate action. Live positions and stop details may be unavailable without removing the itinerary.

## Run locally

Use Node.js 22 and npm:

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. `npm run test` runs the unit tests, `npm run build` builds the static site into `dist`, and `npm run preview` serves that build. Set `VITE_REPOSITORY_URL` to the public repository URL at build time to enable the source and Issues contact links; without it the app identifies itself as local development. No server, routing key or account is needed.

## Deployment and data terms

The supported repository layout places the **contents of `graz-transit/` at the repository root**, including `package.json` and `.github/workflows/deploy.yml`. In the repository, choose **Settings → Pages → GitHub Actions** as the build and deployment source.

The GitHub Actions workflow builds on pushes to `main` and manual dispatch. Deployment to GitHub Pages is separately gated by the repository variable `DATA_TERMS_CONFIRMED` being exactly `true`. Before setting it, resolve the applicable OpenTrafficMap feed reuse terms or obtain maintainer permission, and verify the redistribution terms for the bundled Graz municipal boundary. Neither public technical access nor a successful build establishes permission. The workflow does not create a repository or enable Pages; configure Pages to use GitHub Actions yourself after those prerequisites are met. Transitous permits resource-light open-source non-commercial use subject to its [API policy](https://transitous.org/api/); coordinate larger or automated routing use and provide contact details as required. Also review the [Mobilitätsverbünde terms](https://mobilitaetsverbuende.atlassian.net/wiki/spaces/DBP/pages/185237505/Terms+of+Use).

## Privacy

Origin and destination searches and routing requests are sent to Transitous. Map requests are sent to OpenFreeMap. Location is requested only after a user action; the app does not send the user's location to OpenTrafficMap. Search and trip data are kept in bounded in-memory caches, not persistent location history. The application has no analytics or service-worker offline promise. These providers receive normal network request information, including the referrer where applicable; consult their policies for their handling of that information.

## Data and attribution

- Timetables and routing: [Transitous Sources](https://transitous.org/sources/). Data source: Mobilitätsverbünde Österreich OG - data.mobilitaetsverbuende.at.
- Observed vehicle positions: [OpenTrafficMap](https://opentrafficmap.org/). Positions are opportunistic and may be old or missing.
- Basemap: [OpenFreeMap](https://openfreemap.org/), [OpenMapTiles](https://openmaptiles.org/) and [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- City boundary: Datenquelle: Stadt Graz – [data.graz.gv.at](https://data.graz.gv.at/).
- Roboto and Material icons have their own licences; see `public/THIRD-PARTY-NOTICES.txt` and the referenced licence files.

## Licence and contact

Original application code is licensed under the [MIT License](LICENSE). This does not license third-party data, feeds, fonts or icons. For a deployed copy, use the Issues link derived from its configured repository URL to contact its maintainer.
