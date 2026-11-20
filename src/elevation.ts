import { type Grid, type TileRef, tilesCovering, wrapX } from './grid';

export const MAPTERHORN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const MAPTERHORN_TILESIZE = 512;
/** Highest zoom requested; missing tiles fall back to their parent. */
export const MAPTERHORN_MAXZOOM = 17;

export interface DemTile {
  /** tile whose extent is drawn */
  req: TileRef;
  /** tile whose pixels are used (req or an ancestor when req is missing) */
  src: TileRef;
  image: ImageBitmap;
}

const cache = new Map<string, Promise<ImageBitmap | null>>();
const CACHE_LIMIT = 256;

function fetchOne(t: TileRef): Promise<ImageBitmap | null> {
  const key = `${t.z}/${wrapX(t.x, t.z)}/${t.y}`;
  let p = cache.get(key);
  if (!p) {
    const url = MAPTERHORN_URL.replace('{z}', String(t.z)).replace('{x}', String(wrapX(t.x, t.z))).replace('{y}', String(t.y));
    // Missing tiles (404) stay cached as null; transient failures are evicted so a later rebuild retries.
    const req: Promise<ImageBitmap | null> = fetch(url)
      .then(async (r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      })
      .catch(() => {
        if (cache.get(key) === req) cache.delete(key);
        return null;
      });
    p = req;
    cache.set(key, p);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  } else {
    cache.delete(key);
    cache.set(key, p);
  }
  return p;
}

async function fetchWithFallback(req: TileRef): Promise<DemTile | null> {
  let t = req;
  for (;;) {
    const img = await fetchOne(t);
    if (img) return { req, src: t, image: img };
    if (t.z === 0) return null;
    t = { z: t.z - 1, x: Math.floor(t.x / 2), y: Math.floor(t.y / 2) };
  }
}

/** DEM zoom whose pixel size best matches the grid cell size. */
export function demZoomFor(g: Grid): number {
  const z = Math.round(Math.log2(1 / (g.cell * MAPTERHORN_TILESIZE)));
  return Math.max(0, Math.min(MAPTERHORN_MAXZOOM, z));
}

export async function loadDem(g: Grid): Promise<{ tiles: DemTile[]; zoom: number; missing: number }> {
  const zoom = demZoomFor(g);
  const reqs = tilesCovering(g, zoom);
  const res = await Promise.all(reqs.map(fetchWithFallback));
  const tiles = res.filter((t): t is DemTile => !!t);
  return { tiles, zoom, missing: reqs.length - tiles.length };
}

/** CPU elevation lookup (metres) at a mercator point, bilinear like DEM_FS; NaN outside the loaded tiles. */
export type DemSampler = (mx: number, my: number) => number;

const decoded = new WeakMap<ImageBitmap, ImageData>();

export function demSampler(tiles: DemTile[]): DemSampler | null {
  if (!tiles.length) return null;
  const n = Math.pow(2, tiles[0].req.z);
  const byReq = new Map<string, { src: TileRef; img: ImageData }>();
  for (const t of tiles) {
    let img = decoded.get(t.image);
    if (!img) {
      const c = new OffscreenCanvas(t.image.width, t.image.height);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(t.image, 0, 0);
      img = ctx.getImageData(0, 0, c.width, c.height);
      decoded.set(t.image, img);
    }
    byReq.set(`${t.req.x}/${t.req.y}`, { src: t.src, img });
  }
  return (mx, my) => {
    const e = byReq.get(`${Math.floor(mx * n)}/${Math.floor(my * n)}`);
    if (!e) return NaN;
    const { width: w, height: h, data } = e.img;
    const sn = Math.pow(2, e.src.z);
    const u = (mx * sn - e.src.x) * w - 0.5, v = (my * sn - e.src.y) * h - 0.5;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const at = (x: number, y: number) => {
      const k = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
      return data[k] * 256 + data[k + 1] + data[k + 2] / 256 - 32768;
    };
    const top = at(i, j) * (1 - fu) + at(i + 1, j) * fu;
    const bot = at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu;
    return top * (1 - fv) + bot * fv;
  };
}
