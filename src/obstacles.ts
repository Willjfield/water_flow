import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { type Grid, type TileRef, gridX1, gridY1, tileInCells, tilesCovering, wrapX } from './grid';
import { type Kind, PAINT_ORDER, ruleFor } from './obstacleRules';

/** A feature normalised to the obstacle schema, in tile-local coordinates. */
export interface ObstacleFeature {
  kind: Kind;
  cls: string;
  width?: number;
  type: 1 | 2 | 3;
  rings: { x: number; y: number }[][];
  extent: number;
}

export interface ObstacleSource {
  name: string;
  minzoom: number;
  maxzoom: number;
  /** lon/lat bounds or null for global */
  bounds: [number, number, number, number] | null;
  getTile(t: TileRef, signal?: AbortSignal): Promise<ObstacleFeature[]>;
}

function decode(buf: ArrayBuffer, pick: (layer: string, props: Record<string, unknown>) => { kind: Kind; cls: string; width?: number } | null) {
  const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const out: ObstacleFeature[] = [];
  for (const [name, layer] of Object.entries(vt.layers)) {
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type === 0) continue;
      const k = pick(name, f.properties);
      if (!k) continue;
      out.push({ ...k, type: f.type, rings: f.loadGeometry(), extent: layer.extent });
    }
  }
  return out;
}

/** PMTiles archive produced by scripts/build-obstacles.sh (layer `obstacles`). */
export async function pmtilesSource(url: string): Promise<ObstacleSource> {
  const pm = new PMTiles(url);
  const h = await pm.getHeader();
  return {
    name: url.split('/').pop() ?? url,
    minzoom: h.minZoom,
    maxzoom: h.maxZoom,
    bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
    async getTile(t, signal) {
      const r = await pm.getZxy(t.z, wrapX(t.x, t.z), t.y, signal);
      if (!r) return [];
      return decode(r.data, (layer, p) => {
        if (layer !== 'obstacles') return null;
        return { kind: p.kind as Kind, cls: String(p.class ?? ''), width: typeof p.width === 'number' ? p.width : undefined };
      });
    },
  };
}

/**
 * Global fallback: OpenFreeMap's OpenMapTiles-schema planet tiles. Has buildings, roads
 * and waterways but no barriers/embankments, so a tippecanoe archive is preferred where present.
 */
export async function openFreeMapSource(): Promise<ObstacleSource> {
  const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
  const tmpl: string = tj.tiles[0];
  return {
    name: 'OpenFreeMap (OpenMapTiles)',
    minzoom: 13,
    maxzoom: tj.maxzoom ?? 14,
    bounds: null,
    async getTile(t, signal) {
      const url = tmpl.replace('{z}', String(t.z)).replace('{x}', String(wrapX(t.x, t.z))).replace('{y}', String(t.y));
      const r = await fetch(url, { signal });
      if (!r.ok) return [];
      return decode(await r.arrayBuffer(), (layer, p) => {
        const brunnel = p.brunnel as string | undefined;
        if (layer === 'building') return p.hide_3d ? null : { kind: 'building', cls: 'building' };
        if (layer === 'transportation') {
          if (brunnel === 'bridge' || brunnel === 'tunnel') return null;
          const c = String(p.class ?? '');
          if (c === 'rail' || c === 'transit') return { kind: 'road', cls: 'rail' };
          if (c === 'ferry' || c === 'aerialway') return null;
          const map: Record<string, string> = { minor: 'residential', path: 'footway', motorway_construction: 'motorway' };
          return { kind: 'road', cls: map[c] ?? c };
        }
        if (layer === 'waterway') {
          return { kind: 'waterway', cls: brunnel === 'tunnel' ? 'culvert' : String(p.class ?? 'stream') };
        }
        return null;
      });
    },
  };
}

/** True when the source's bounds contain the whole grid (partial archives would drop obstacles outside them). */
export function sourceCovers(src: ObstacleSource, g: Grid): boolean {
  if (!src.bounds) return true;
  const [w, s, e, n] = src.bounds;
  const lon = (x: number) => x * 360 - 180;
  const lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return lon(g.x0) >= w && lon(gridX1(g)) <= e && lat(g.y0) <= n && lat(gridY1(g)) >= s;
}

/** Minimum map zoom at which obstacles are rasterised (cells must be ~building scale). */
export const OBSTACLE_MIN_CELL_M = 12;
const MAX_TILES = 160;

/**
 * Rasterise obstacle tiles into an RGBA8 image aligned with the grid:
 * R = 255 blocked, G = 128 + dz/0.05, B = Manning n * 1000 (0 = background).
 */
export async function rasterizeObstacles(g: Grid, src: ObstacleSource, signal?: AbortSignal): Promise<{ data: Uint8Array; features: number; tiles: number } | null> {
  if (g.dx > OBSTACLE_MIN_CELL_M) return null;
  const z = src.maxzoom;
  const tiles = tilesCovering(g, z);
  if (tiles.length > MAX_TILES) return null;
  const results = await Promise.all(tiles.map((t) => src.getTile(t, signal).then((f) => ({ t, f })).catch(() => ({ t, f: [] as ObstacleFeature[] }))));

  const canvas = new OffscreenCanvas(g.nx, g.ny);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = 'rgb(0,128,0)';
  ctx.fillRect(0, 0, g.nx, g.ny);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let count = 0;

  for (const kind of PAINT_ORDER) {
    for (const { t, f: feats } of results) {
      const { ox, oy, size } = tileInCells(g, t);
      for (const f of feats) {
        if (f.kind !== kind) continue;
        const rule = ruleFor(f.kind, f.cls);
        if (!rule) continue;
        const r = rule.blocked ? 255 : 0;
        const gch = Math.max(0, Math.min(255, Math.round(128 + (rule.dz ?? 0) / 0.05)));
        const b = rule.n ? Math.min(255, Math.round(rule.n * 1000)) : 0;
        const color = `rgb(${r},${gch},${b})`;
        const s = size / f.extent;
        ctx.beginPath();
        for (const ring of f.rings) {
          ring.forEach((p, i) => {
            const x = ox + p.x * s, y = oy + p.y * s;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          if (f.type === 3) ctx.closePath();
        }
        if (f.type === 3) {
          ctx.fillStyle = color;
          ctx.fill('evenodd');
        } else if (f.type === 2) {
          const w = (f.width ?? rule.width) / g.dx;
          ctx.strokeStyle = color;
          // blocking lines must stay 8-connected so 4-neighbour flow can't leak through
          ctx.lineWidth = Math.max(w, rule.blocked ? 1.5 : 1);
          ctx.stroke();
        }
        count++;
      }
    }
  }
  const img = ctx.getImageData(0, 0, g.nx, g.ny);
  return { data: new Uint8Array(img.data.buffer), features: count, tiles: tiles.length };
}
