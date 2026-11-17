# water_flow

Real-time GPU shallow-water simulation over global [Mapterhorn](https://mapterhorn.com) elevation, rendered as a MapLibre GL JS custom layer (raw WebGL2). Works anywhere Mapterhorn has coverage; most meaningful at z12+.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle in dist/
```

## How it works

- **Grid** (`src/grid.ts`): a Web Mercator grid covering the viewport plus a 25% gutter. Cell size is snapped to a power of two in Mercator space (~1/2/4 CSS px per cell, max 2M cells) so grids stay aligned as the map moves.
- **Elevation** (`src/elevation.ts`): Mapterhorn Terrarium WebP tiles (`height = R*256 + G + B/256 - 32768`) are drawn into an RGBA32F bed texture on every grid rebuild (`moveend`). Missing tiles fall back to parents.
- **Simulation** (`src/shaders.ts`, `src/waterLayer.ts`): local-inertial shallow-water scheme on ping-pong RGBA32F targets (`r` depth, `g`/`b` face fluxes). A flux pass (momentum + Manning friction) and a depth pass (continuity + rain/pour/infiltration source terms) run per substep. Substeps are CFL-limited from a GPU reduction of max wave speed, read back asynchronously via a PBO. Water is resampled onto the new grid on move ("Keep water on move"), or reset.
- **Sources**: *Rain* adds uniform dh/dt; *Pour* adds dh/dt inside the brush radius at the cursor (lngLat → Mercator → grid cell). Hold the mouse (or touch) to pour.
- **Obstacles** (`src/obstacles.ts`, `src/obstacleRules.ts`): vector tiles are rasterized at runtime into a blocked/bed-delta/roughness texture. Buildings are no-flow cells; roads, rail and embankments are raised and rough; barriers are raised walls; waterways are lowered channels.
- **Rendering**: depth-tinted translucent blue water composited over the basemap, plus optional GPU particles advected along the velocity field.

## Obstacle data

The app picks an obstacle source per grid ("Obstacles" select):

1. Local PMTiles archives listed in `public/obstacles/index.json` when one covers the grid (a Monaco sample ships in the repo).
2. Otherwise OpenFreeMap's global OpenMapTiles vector tiles (buildings, transportation, waterways) as a fallback.

Build a PMTiles archive from any OSM extract (needs `osmium`, `tippecanoe`, `python3`):

```sh
curl -LO https://download.geofabrik.de/europe/monaco-latest.osm.pbf
npm run build:obstacles -- monaco-latest.osm.pbf public/obstacles/monaco.pmtiles [minlon,minlat,maxlon,maxlat]
```

then add the path to `public/obstacles/index.json`. The pipeline (`scripts/build-obstacles.sh`) filters buildings, highways, railways, barriers, embankments/dykes and waterways with `osmium tags-filter`, normalizes them with `scripts/classify_osm.py` into a single `obstacles` layer (`kind`, `class`, `width`), and tiles z13–z14 with tippecanoe.

## Controls

Mode (Rain/Pour, `P`), rain rate, pour rate, brush radius, sim speed, infiltration, Manning n, minimum visible depth, obstacle source, cell size, particles, obstacle overlay, keep water on move, sea sink (drain cells at or below 0 m), Pause (`Space`), Reset (`R`).
