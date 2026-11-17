import { MercatorCoordinate, type Map as MlMap } from 'maplibre-gl';

const EARTH_CIRCUMFERENCE = 40075016.686;

/**
 * Simulation grid in Web Mercator. Cells are square in mercator (and therefore in
 * metres, locally). Row 0 is the northern edge (smallest mercator y).
 */
export interface Grid {
  /** mercator origin (NW corner) */
  x0: number;
  y0: number;
  /** cell size in mercator units (power of two, so grids nest across zooms) */
  cell: number;
  nx: number;
  ny: number;
  /** cell size in metres at the grid's centre latitude */
  dx: number;
}

export const gridX1 = (g: Grid) => g.x0 + g.nx * g.cell;
export const gridY1 = (g: Grid) => g.y0 + g.ny * g.cell;

export function viewportBounds(map: MlMap) {
  const c = map.getCanvas();
  const w = c.clientWidth, h = c.clientHeight;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const m = MercatorCoordinate.fromLngLat(map.unproject([px, py]));
    x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x);
    y0 = Math.min(y0, m.y); y1 = Math.max(y1, m.y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Build a grid covering the viewport plus a gutter (total size `1 + gutter` per axis).
 * `cellPx` is the target cell size in CSS pixels; the actual cell size is snapped to
 * a power of two in mercator so successive grids align exactly.
 */
export function computeGrid(map: MlMap, cellPx: number, gutter = 0.25, maxCells = 2_000_000): Grid {
  const vb = viewportBounds(map);
  const gx = ((vb.x1 - vb.x0) * gutter) / 2;
  const gy = ((vb.y1 - vb.y0) * gutter) / 2;
  const bx0 = vb.x0 - gx, bx1 = vb.x1 + gx, by0 = Math.max(0, vb.y0 - gy), by1 = Math.min(1, vb.y1 + gy);
  const worldPx = 512 * Math.pow(2, map.getZoom());
  let cell = Math.pow(2, Math.round(Math.log2(cellPx / worldPx)));
  while (Math.ceil((bx1 - bx0) / cell) * Math.ceil((by1 - by0) / cell) > maxCells) cell *= 2;
  const x0 = Math.floor(bx0 / cell) * cell;
  const y0 = Math.floor(by0 / cell) * cell;
  const nx = Math.ceil((bx1 - x0) / cell);
  const ny = Math.ceil((by1 - y0) / cell);
  const latC = new MercatorCoordinate(x0 + (nx * cell) / 2, y0 + (ny * cell) / 2).toLngLat().lat;
  const dx = cell * EARTH_CIRCUMFERENCE * Math.cos((latC * Math.PI) / 180);
  return { x0, y0, cell, nx, ny, dx };
}

/** True if the current viewport still lies inside `g` and the cell size is unchanged. */
export function gridStillValid(map: MlMap, g: Grid, cellPx: number): boolean {
  const worldPx = 512 * Math.pow(2, map.getZoom());
  if (Math.pow(2, Math.round(Math.log2(cellPx / worldPx))) !== g.cell) return false;
  const vb = viewportBounds(map);
  return vb.x0 >= g.x0 && vb.y0 >= g.y0 && vb.x1 <= gridX1(g) && vb.y1 <= gridY1(g);
}

export interface TileRef { z: number; x: number; y: number }

/** Tiles at zoom z intersecting the grid. x is unwrapped (may be <0 or >=2^z). */
export function tilesCovering(g: Grid, z: number): TileRef[] {
  const n = Math.pow(2, z);
  const out: TileRef[] = [];
  const tx0 = Math.floor(g.x0 * n), tx1 = Math.floor((gridX1(g) - 1e-12) * n);
  const ty0 = Math.max(0, Math.floor(g.y0 * n)), ty1 = Math.min(n - 1, Math.floor((gridY1(g) - 1e-12) * n));
  for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) out.push({ z, x, y });
  return out;
}

export const wrapX = (x: number, z: number) => {
  const n = Math.pow(2, z);
  return ((x % n) + n) % n;
};

/** Tile extent expressed in grid cell units (origin + size). */
export function tileInCells(g: Grid, t: TileRef) {
  const size = 1 / Math.pow(2, t.z);
  return { ox: (t.x * size - g.x0) / g.cell, oy: (t.y * size - g.y0) / g.cell, size: size / g.cell };
}
