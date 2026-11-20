import { type Grid, type TileRef, tileInCells } from './grid';
import type { DemSampler } from './elevation';
import type { ObstacleFeature } from './obstacles';
import { ruleFor } from './obstacleRules';

/**
 * Bed-elevation override that removes bridge decks (and other humps) the DEM records
 * across watercourses, so they don't act as dams:
 *
 * 1. Waterway burn: OSM waterways are drawn downstream, so along each line the bed is
 *    capped at the lowest elevation seen upstream. Bridges, culverted embankments and
 *    DEM noise in the channel are cut down to the upstream water level.
 * 2. Bridge fill: cells where a bridge crosses water (area polygons or waterway
 *    footprints) take the lowest elevation of the water cells around them, which
 *    covers wide rivers whose banks extend past the waterway line's footprint.
 *
 * The result is absolute elevation per cell; NO_OVERRIDE where the DEM is kept.
 */
export const NO_OVERRIDE = 1e9;
/** Never lower a cell more than this below the DEM (guards against wrong directions and DEM voids). */
const MAX_CUT_M = 30;
/** Extra width either side of a bridge's road footprint, plus the DEM's smoothing. */
const BRIDGE_MARGIN_M = 3;
/** Reverse a waterway piece whose end is this much higher than its start (mistagged direction). */
const REVERSE_THRESHOLD_M = 1;

export interface BedOverride {
  bed: Float32Array;
  /** waterway pieces whose profile was cut */
  burned: number;
  /** bridge-over-water patches filled */
  bridges: number;
}

type Pt = [number, number];

export function buildBedOverride(g: Grid, tiles: { t: TileRef; f: ObstacleFeature[] }[], dem: DemSampler, demZoom: number): BedOverride {
  const { nx, ny } = g;
  const bed = new Float32Array(nx * ny).fill(NO_OVERRIDE);
  const demAt = (cx: number, cy: number) => dem(g.x0 + cx * g.cell, g.y0 + cy * g.cell);
  const lineWidthM = (f: ObstacleFeature) => f.width ?? ruleFor(f.kind === 'bridge' ? 'road' : f.kind, f.cls)?.width ?? 2;

  const parts: { f: ObstacleFeature; pts: Pt[] }[] = [];
  for (const { t, f: feats } of tiles) {
    const { ox, oy, size } = tileInCells(g, t);
    for (const f of feats) {
      if (f.kind !== 'waterway' && f.kind !== 'water' && f.kind !== 'bridge') continue;
      const s = size / f.extent;
      for (const ring of f.rings) parts.push({ f, pts: ring.map((p) => [ox + p.x * s, oy + p.y * s] as Pt) });
    }
  }

  // ---- 1. waterway burn
  let burned = 0;
  for (const { f, pts } of parts) {
    if (f.kind !== 'waterway' || f.type !== 2 || pts.length < 2) continue;
    const r = Math.max(lineWidthM(f) / 2 / g.dx, 0.75);
    const step = 0.5;
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let q = 0; q < m; q++) { xs.push(ax + ((bx - ax) * q) / m); ys.push(ay + ((by - ay) * q) / m); }
    }
    xs.push(pts[pts.length - 1][0]); ys.push(pts[pts.length - 1][1]);
    const e = xs.map((x, i) => demAt(x, ys[i]));
    const quart = Math.max(1, Math.floor(e.length / 4));
    const minOf = (a: number[]) => a.reduce((m, v) => (v < m ? v : m), Infinity);
    const head = minOf(e.slice(0, quart)), tail = minOf(e.slice(-quart));
    // only judge direction when both ends have DEM coverage
    if (Number.isFinite(head) && Number.isFinite(tail) && tail > head + REVERSE_THRESHOLD_M) { xs.reverse(); ys.reverse(); e.reverse(); }
    const stampEvery = Math.max(1, Math.floor(r / 2 / step));
    let z = Infinity, cut = false;
    for (let i = 0; i < e.length; i++) {
      if (!Number.isFinite(e[i])) continue;
      z = Math.max(Math.min(z, e[i]), e[i] - MAX_CUT_M);
      if (z < e[i] - 0.25) cut = true;
      if (i % stampEvery === 0 || i === e.length - 1) stampDisc(bed, nx, ny, xs[i], ys[i], r, z);
    }
    if (cut) burned++;
  }

  // ---- 2. bridge fill
  const canvas = new OffscreenCanvas(nx, ny);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, nx, ny);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const demPxM = (g.dx / g.cell) / (512 * Math.pow(2, demZoom));
  const marginCells = (BRIDGE_MARGIN_M + demPxM) / g.dx;
  let anyBridge = false;
  for (const kind of ['water', 'waterway', 'bridge'] as const) {
    const color = kind === 'bridge' ? 'rgb(0,255,0)' : 'rgb(255,0,0)';
    ctx.fillStyle = ctx.strokeStyle = color;
    for (const f of new Set(parts.filter((p) => p.f.kind === kind).map((p) => p.f))) {
      if (kind === 'bridge') anyBridge = true;
      ctx.beginPath();
      for (const p of parts) {
        if (p.f !== f) continue;
        p.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        if (f.type === 3) ctx.closePath();
      }
      if (f.type === 3) {
        ctx.fill('evenodd');
        if (kind === 'bridge') { ctx.lineWidth = 2 * marginCells; ctx.stroke(); }
      } else if (f.type === 2) {
        const w = lineWidthM(f) / g.dx;
        ctx.lineWidth = kind === 'bridge' ? w + 2 * marginCells : Math.max(w, 1);
        ctx.stroke();
      }
    }
  }
  let bridges = 0;
  if (anyBridge) {
    const px = ctx.getImageData(0, 0, nx, ny).data;
    const water = (i: number) => px[i * 4] > 127;
    const mask = (i: number) => px[i * 4] > 127 && px[i * 4 + 1] > 127;
    const seen = new Uint8Array(nx * ny);
    const comp: number[] = [];
    for (let s0 = 0; s0 < nx * ny; s0++) {
      if (seen[s0] || !mask(s0)) continue;
      comp.length = 0;
      comp.push(s0);
      seen[s0] = 1;
      let level = Infinity;
      for (let k = 0; k < comp.length; k++) {
        const c = comp[k], cx = c % nx, cy = (c - cx) / nx;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
          const nb = y * nx + x;
          if (mask(nb)) {
            if (!seen[nb]) { seen[nb] = 1; comp.push(nb); }
          } else if (water(nb)) {
            const z = Math.min(demAt(x + 0.5, y + 0.5), bed[nb]);
            if (z < level) level = z;
          }
        }
      }
      if (!Number.isFinite(level)) continue;
      bridges++;
      for (const c of comp) {
        const cx = c % nx, cy = (c - cx) / nx;
        const z = Math.max(level, demAt(cx + 0.5, cy + 0.5) - MAX_CUT_M);
        if (z < bed[c]) bed[c] = z;
      }
    }
  }
  return { bed, burned, bridges };
}

function stampDisc(bed: Float32Array, nx: number, ny: number, cx: number, cy: number, r: number, z: number) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(nx - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(ny - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * nx + x;
      if (z < bed[i]) bed[i] = z;
    }
  }
}
