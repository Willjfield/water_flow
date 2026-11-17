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
