# WORLDVIEW OSINT — Progress Log

> Hand-off file. Any AI/dev continuing this work: read this first, then continue from **Next steps**.
> Source repo: https://github.com/daggerm29-oss/sky8 (branch `main`, imported into the v0 workspace without `.git`).

## Architecture (as found)

```
next dev (port 3000, scripts/dev.mjs)  --rewrites /*-->  Vite dev server (5173)
                                                           artifacts/worldview (React 19 + MapLibre GL v5 + Cesium + three)
                                                           vite.config.ts mounts the Express routers from
                                                           artifacts/api-server/src/routes (proxy.ts, cctv.ts) at /api
Express proxy (/api/proxy/*)  --> upstream maritime backend (SHIPS_UPSTREAM_URL) + adsb.lol + CelesTrak + CCTV feeds
```

- `artifacts/worldview/src/pages/WorldviewMap.tsx` (~2.5k lines) — main map page, state, layers, toolbar.
- `components/ShipsLayer.tsx`, `SatelliteLayer.tsx`, `PlaybackLayer.tsx`, `CctvLayer.tsx` — MapLibre layers.
- `components/CesiumFollowCam.tsx` — Cesium 3D follow camera (pre-existing, aircraft only).
- `components/CinematicOverlay.tsx`, `FloatingPanel.tsx`, `MaritimePanel.tsx`, `MasterToolbar.tsx`.
- `artifacts/api-server/src/routes/proxy.ts` — all upstream proxies (ships, dark-fleet, oil, status, playback, adsb).
- 3D models in `artifacts/worldview/public/`: `aeroplane.glb`, `military-aircraft.glb`, `satellite.glb`, `iss.glb`, `ship.glb`, `tanker.glb`.
- npm workspaces (root `package.json`); install with `npm install` at repo root.

## New backend: https://worldview-intel-i09c.onrender.com

Verified live 2026-10-17 (same JSON schema as the old Render backend):
- `/api/status` → `{live_vessels, dark_ships_tracked, ais:{...}, uptime_min}`
- `/api/radar` → `[{mmsi, vessel_name, lat, lon, sog, cog, last_updated, dwt, est_barrels, category, source}]` (~3.3 MB)
- `/api/live` → same without dwt/category
- `/api/dark-fleet` → `[{mmsi, ship_name, last_known_lat, last_known_lon, time_went_dark, last_sog, last_cog}]`
- `/api/analytics/live-oil`, `/api/playback/config` → OK

## Step log

- [x] **Step 1** — Cloned repo, mapped architecture, probed new backend (all endpoints 200).
- [x] **Step 2** — Imported repo into v0 workspace; removed conflicting v0 template files.
- [x] **Step 3** — Backend migration: `proxy.ts` default `SHIPS_UPSTREAM_URL` → `https://worldview-intel-i09c.onrender.com`,
      `.env.example` + `replit.md` updated. `grep -r onrender` is clean.
- [x] **Step 4** — Single-click → right-side `EntityInfoPanel` (ship / aircraft / satellite). `ShipsLayer` got `onSelect/onTrack`
      (padded bbox picking); `SatelliteLayer` got `onFocus/onTrack` (dblclick); aircraft already had click/dblclick and now also feeds the panel via `focus` state in `WorldviewMap.tsx`.
- [x] **Step 5** — Double-click → cinematic 3D follow view. New `lib/tracked-entity.ts`, `components/CinematicTracker.tsx`
      (Cesium, own lookAt camera: log-range intro zoom-in from 3000 km, drag-orbit, wheel zoom, dead reckoning, trail, fade),
      `CinematicHost.tsx` (keeps last target mounted so exit = pull-back + fade, ~1.5s), `CinematicController` in `WorldviewMap.tsx`.
      Models: aeroplane/military-aircraft/ship/tanker/satellite/iss .glb. Esc or panel EXIT 3D exits. Old `CesiumFollowCam.tsx` is now unused (safe to delete).
- [x] **Step 6** — `npm install` + `node scripts/dev.mjs` (Next :3000 -> Vite :5173). Browser-verified aircraft path end to end:
      click -> right panel, TRACK 3D -> intro zoom + GLB aircraft over 3D terrain with panel kept visible, Esc -> pull-back + fade + map restore.
      Ships/satellites share the same code path and type-check, but were NOT live-tested: the new backend currently reports
      `live_vessels: 0` (AIS socket closed), only 50 dark-fleet gap candidates; satellites need 3D ORBITAL + SATS on.

- [x] **Step 7** — Aircraft feed hardening: `proxy.ts` slims adsb.lol payload (7 MB → ~2 MB), dedupes in-flight
      upstream fetches, serves stale while refreshing; `WorldviewMap.tsx` `fetchData` skips overlapping polls,
      45 s timeout, keeps last aircraft on transient failure (no more "FEED INTERRUPTED" + 0 contacts).

## Step 8 — 3D cinematic view fixes (IN PROGRESS, all in `components/CinematicTracker.tsx` unless noted)
User report: dblclick 3D slow / sometimes no model; ship floats above sea; plane faces wrong way;
model jitters forward/back; remove red/white/green dots (wingtip lights) and the line (trail).
Root causes found:
- Slow: entity was created only AFTER `await loadGoogleTileset()` → model waited on tiles. Fix: add entity first,
  load tiles in background; prefetch GLBs on app start (`lib/tracked-entity.ts` `preloadModels`).
- Floating ship: placed at ellipsoid h=0, Google tiles sea is at geoid (~-30..-60 m in Arabian Sea). Fix: sample
  surface height under the vessel from the tileset (`scene.clampToHeightMostDetailed`) and put hull at waterline.
- Jitter: each new sample restarted dead reckoning from an older position → snap back. Fix: display has its own
  velocity, error corrected smoothly with forward-only along-track clamp.
- Wrong facing: per-model heading offset verified visually (see `MODEL_HEADING_OFFSET`).
- Extra root cause of jitter: `CinematicController` (WorldviewMap.tsx) rebuilds `target` every render, and the
  tracker treated each render as a new sample → dead reckoning restarted from the stale fix. Now keyed by value.
- [x] 8a remove lights + trail  - [x] 8b non-blocking load + `preloadModels` (called in WorldviewMap)
- [x] 8c sea-level: `scene.sampleHeightMostDetailed` every 5 s, hull at `surface + keelDepth*scale` (`MODEL_GEOMETRY`)
- [x] 8d smooth motion (own velocity + clamped error correction; aircraft `seen` → `sampleAgeSec`)
- [x] Fixed vessel "LAST UPDATE: Invalid Date" (ISO string timestamps)
- [x] 8e heading offset verified in browser (side view, yaw -90°): all 4 aircraft/ship models need 180°
      (was -90 → sideways). Satellites kept at -90 (unchanged, unverified).
- [x] Model is now a `Cesium.Model` primitive whose matrix is set in the same preRender as the camera
      (entity version trailed ~1 frame behind the camera → stutter).
- [x] Ship waterline verified over Google tiles sea (Spain coast, sampled surface ≈ +37 m ellipsoidal).
- [x] Temp debug hooks removed. **Step 8 DONE.**
- tsc clean (except pre-existing `src/components/ui/*`). `scripts/analyze-glb.mjs` = model bounds tool.

## Step 9 — VISION MODES (IN PROGRESS, started 2026-10-19)
Request: switchable vision modes over the map AND the photorealistic Google 3D tiles (cinematic view):
Tactical (existing dark, default), Normal (optical), CRT/Retro, NVG, FLIR (thermal), Anime, Noir, Snow, Satellite.
Aircraft/ship/satellite icons + 3D models must match each mode.

Design (all new code is self-contained):
- `src/lib/vision-modes.ts` — `VisionMode` type, `VISION_MODES` config (label, hotkey, CSS `filter` string,
  imagery on/off, entity paint overrides), `applyVisionToMap(map, mode, baseLayerIds)`:
  adds Esri World Imagery raster under the base-style labels for every mode except Tactical, and overrides
  icon/circle/line colours + halos of all app (non-base-style) layers (FLIR/NVG/Noir → white-hot; Anime/Snow/Optical → dark outline). Originals are cached and restored.
- `src/components/VisionFilters.tsx` — hidden `<svg>` with SVG filter chains (NVG phosphor+bloom, FLIR WHOT/BHOT/IRONBOW,
  CRT RGB split+bloom, Anime posterize+ink edges, Noir S-curve, Snow whitening, Satellite sharpen).
- `src/components/VisionOverlay.tsx` — pointer-events:none effects + HUD per mode (grain, scanlines, aperture grille,
  tube vignette, falling-snow canvas, FLIR reticle + palette bar, satellite telemetry/grid).
- `src/components/VisionModeSelector.tsx` — top-centre switcher (hotkeys 1–9) + FLIR palette sub-toggle. Persisted in localStorage (UI pref only).
- `WorldviewMap.tsx` — all world layers (map canvas, satellite canvas, Cesium cinematic) wrapped in one `<div style={{filter}}>`
  so map, icons and 3D models get the identical treatment; records base-style layer ids on load; re-applies on `styledata`.
- `CinematicTracker.tsx` — `visionMode` prop: night tile shader only in Tactical; Esri imagery globe otherwise.

Checklist:
- [x] 9a vision-modes.ts  - [x] 9b VisionFilters  - [x] 9c VisionOverlay  - [x] 9d Selector
- [x] 9e wired into WorldviewMap (+CinematicController/Host/Tracker `visionMode` prop). tsc clean.
- [ ] 9f browser-verify every mode (screenshots), tune filter strengths if needed

## Next steps
- Live-test ship (dblclick a dark-fleet dot) and satellite (3D ORBITAL, SATS) cinematic views; tune `KIND_CONFIG` in `CinematicTracker.tsx` (scale/range per kind).
- Aircraft wingtip/strobe lights use fixed metre offsets and look too wide vs the min-pixel-sized model; scale them or drop them.
- Exiting 3D currently also deselects the aircraft (legacy behaviour); ships/satellites keep their panel open.
- Remaining pre-existing TS errors are only in `src/components/ui/*` (React type version mismatch).

## Design for steps 4–5

New / changed files:
- `src/lib/tracked-entity.ts` — `EntityRef = {kind:"aircraft"|"ship"|"satellite", id}`, `FollowTarget`
  (lat, lon, altM, headingDeg, speedMs), model-URL/scale picker per entity.
- `src/components/EntityInfoPanel.tsx` — right-side panel (top-right, zIndex 30) with live name / position /
  movement / intel fields + "TRACK 3D" / "EXIT 3D" button. Stays visible during tracking.
- `src/components/CinematicTracker.tsx` — generic Cesium follow-cam (replaces aircraft-only CesiumFollowCam usage):
  camera.lookAt each frame with own drag/wheel orbit, dead-reckoning between samples (heading+speed),
  intro zoom-in + fade, exit zoom-out + fade then `onExited`. Trail polyline behind the model.
- `ShipsLayer.tsx` — `onSelect(ship)` on click, `onTrack(ship)` on dblclick.
- `SatelliteLayer.tsx` — `onSelect` + `onTrack` (dblclick) via the projected hit test.
- `WorldviewMap.tsx` — `selectedEntity` + `trackedEntity` state.

Models: `aeroplane.glb` (civil), `military-aircraft.glb` (mil — old code pointed at a missing `jet.glb`),
`ship.glb`, `tanker.glb` (TANKER), `satellite.glb`, `iss.glb` (ISS/ZARYA). All ~1.9 units long on X →
same `heading - 90°` orientation; scale per kind.

