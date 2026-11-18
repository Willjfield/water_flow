import { Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
// maplibre-gl resolves its worker relative to import.meta.url, which bundlers rewrite; ship it as an asset.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { WaterLayer, type SimParams, type SimStats } from './waterLayer';
import { type ObstacleSource, openFreeMapSource, pmtilesSource, sourceCovers } from './obstacles';
import type { Grid } from './grid';
import { MAPTERHORN_TILESIZE, MAPTERHORN_URL } from './elevation';

setWorkerUrl(workerUrl);

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';

const params: SimParams = {
  mode: 'rain',
  rainMmPerHr: 100,
  pourMmPerS: 50,
  brushRadiusM: 25,
  simSpeed: 50,
  infilMmPerHr: 8,
  manningN: 0.035,
  minDepthM: 0.01,
  opacity: 0.85,
  particles: true,
  showObstacles: true,
  seaSink: true,
  keepWater: true,
  paused: false,
  cellPx: 2,
};

type ObstacleMode = 'auto' | 'local' | 'openfreemap' | 'off';
let obstacleMode: ObstacleMode = 'auto';

// ------------------------------------------------------------ obstacle sources
const localSources: Promise<ObstacleSource[]> = fetch(`${import.meta.env.BASE_URL}obstacles/index.json`)
  .then((r) => (r.ok ? r.json() : []))
  .then((urls: string[]) =>
    Promise.all(urls.map((u) => pmtilesSource(new URL(u, location.origin + import.meta.env.BASE_URL).href).catch(() => null))),
  )
  .then((s) => s.filter((x): x is ObstacleSource => !!x))
  .catch(() => []);
let ofm: Promise<ObstacleSource> | null = null;

async function resolveObstacleSource(g: Grid): Promise<ObstacleSource | null> {
  if (obstacleMode === 'off') return null;
  if (obstacleMode !== 'openfreemap') {
    const local = (await localSources).find((s) => sourceCovers(s, g));
    if (local || obstacleMode === 'local') return local ?? null;
  }
  return (ofm ??= openFreeMapSource());
}

// ------------------------------------------------------------ map
const map = new MlMap({
  container: 'map',
  style: BASEMAP,
  center: [7.4215, 43.7365],
  zoom: 16,
  maxPitch: 45,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');

const layer = new WaterLayer(params, resolveObstacleSource);
layer.onError = (msg) => showError(msg);

map.on('load', () => {
  map.setProjection({ type: 'mercator' });
  map.addSource('mapterhorn', {
    type: 'raster-dem',
    tiles: [MAPTERHORN_URL],
    encoding: 'terrarium',
    tileSize: MAPTERHORN_TILESIZE,
    maxzoom: 15,
    attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
  });
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(
    { id: 'hillshade', type: 'hillshade', source: 'mapterhorn', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#5a5a6a' } },
    firstSymbol,
  );
  map.addLayer(layer, firstSymbol);
});

// ------------------------------------------------------------ pouring
const canvas = map.getCanvasContainer();
let pouring = false;
function setMode(m: SimParams['mode']) {
  params.mode = m;
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => (r.checked = r.value === m));
  canvas.classList.toggle('pour-mode', m === 'pour');
  if (m === 'pour') map.dragPan.disable(); else map.dragPan.enable();
  if (m !== 'pour') layer.pourAt = null;
}
map.on('mousedown', (e) => {
  if (params.mode !== 'pour' || e.originalEvent.button !== 0) return;
  pouring = true;
  layer.pourAt = e.lngLat;
});
map.on('mousemove', (e) => { if (pouring) layer.pourAt = e.lngLat; });
const stopPour = () => { pouring = false; layer.pourAt = null; };
map.on('mouseup', stopPour);
canvas.addEventListener('mouseleave', stopPour);
map.on('touchstart', (e) => {
  if (params.mode !== 'pour' || e.points.length !== 1) return;
  e.preventDefault();
  pouring = true;
  layer.pourAt = e.lngLat;
});
map.on('touchmove', (e) => { if (pouring) layer.pourAt = e.lngLat; });
map.on('touchend', stopPour);

// ------------------------------------------------------------ UI
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function bindRange(id: string, key: keyof SimParams, fmt: (v: number) => string, opts: { log?: boolean; onChange?: () => void } = {}) {
  const input = $<HTMLInputElement>(id);
  const out = $<HTMLOutputElement>(`${id}-val`);
  const min = Number(input.min), max = Number(input.max);
  const toVal = (t: number) => (opts.log ? Math.exp(Math.log(min || 1e-6) + (Math.log(max) - Math.log(min || 1e-6)) * t) : t);
  const toPos = (v: number) => (opts.log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : v);
  if (opts.log) { input.min = '0'; input.max = '1'; input.step = '0.001'; }
  input.value = String(toPos(params[key] as number));
  const update = () => {
    const v = toVal(Number(input.value));
    (params as unknown as Record<string, number>)[key] = v;
    out.textContent = fmt(v);
    opts.onChange?.();
    map.triggerRepaint();
  };
  input.addEventListener('input', update);
  out.textContent = fmt(params[key] as number);
}

function bindCheck(id: string, key: keyof SimParams, onChange?: () => void) {
  const input = $<HTMLInputElement>(id);
  input.checked = params[key] as boolean;
  input.addEventListener('change', () => {
    (params as unknown as Record<string, boolean>)[key] = input.checked;
    onChange?.();
    map.triggerRepaint();
  });
}

const n0 = (v: number) => v.toFixed(0);
bindRange('rain', 'rainMmPerHr', (v) => `${v < 10 ? v.toFixed(1) : n0(v)} mm/h`, { log: true });
bindRange('pour', 'pourMmPerS', (v) => `${n0(v)} mm/s`, { log: true });
bindRange('brush', 'brushRadiusM', (v) => `${n0(v)} m`, { log: true });
bindRange('speed', 'simSpeed', (v) => `${v < 10 ? v.toFixed(1) : n0(v)}×`, { log: true });
bindRange('infil', 'infilMmPerHr', (v) => `${n0(v)} mm/h`);
bindRange('manning', 'manningN', (v) => v.toFixed(3), { onChange: () => layer.markBedDirty() });
bindRange('mindepth', 'minDepthM', (v) => `${(v * 100).toFixed(1)} cm`, { log: true });
bindCheck('particles', 'particles');
bindCheck('showobs', 'showObstacles');
bindCheck('seasink', 'seaSink');
bindCheck('keepwater', 'keepWater');

document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) =>
  r.addEventListener('change', () => r.checked && setMode(r.value as SimParams['mode'])),
);
$<HTMLSelectElement>('obstacles').addEventListener('change', (e) => {
  obstacleMode = (e.target as HTMLSelectElement).value as ObstacleMode;
  layer.reloadObstacles();
});
$<HTMLSelectElement>('res').value = String(params.cellPx);
$<HTMLSelectElement>('res').addEventListener('change', (e) => {
  params.cellPx = Number((e.target as HTMLSelectElement).value);
  layer.rebuild();
});
const pauseBtn = $<HTMLButtonElement>('pause');
pauseBtn.addEventListener('click', () => {
  params.paused = !params.paused;
  pauseBtn.textContent = params.paused ? 'Resume' : 'Pause';
  map.triggerRepaint();
});
$<HTMLButtonElement>('reset').addEventListener('click', () => layer.reset());
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.key === 'p') setMode(params.mode === 'pour' ? 'rain' : 'pour');
  if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
  if (e.key === 'r') layer.reset();
});
const tooltip = $('tooltip');
const hideTooltip = () => (tooltip.hidden = true);
window.addEventListener('keydown', (e) => e.key === 'Escape' && hideTooltip());
document.querySelectorAll<HTMLLabelElement>('label[data-tip]').forEach((el, i) => {
  const desc = document.createElement('span');
  desc.id = `tip-${i}`;
  desc.hidden = true;
  desc.textContent = el.dataset.tip!;
  const icon = document.createElement('span');
  icon.className = 'tip-icon';
  icon.textContent = '?';
  icon.tabIndex = 0;
  icon.setAttribute('role', 'button');
  icon.setAttribute('aria-label', 'Help');
  icon.setAttribute('aria-describedby', desc.id);
  el.append(icon, desc);
  const control = el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector('input');
  control?.setAttribute('aria-describedby', desc.id);
  const show = () => {
    tooltip.textContent = el.dataset.tip!;
    tooltip.hidden = false;
    const r = icon.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(r.right + 8, innerWidth - t.width - 8)}px`;
    tooltip.style.top = `${Math.max(8, Math.min(r.top - 6, innerHeight - t.height - 8))}px`;
  };
  icon.addEventListener('mouseenter', show);
  icon.addEventListener('focus', show);
  icon.addEventListener('mouseleave', hideTooltip);
  icon.addEventListener('blur', hideTooltip);
  icon.addEventListener('click', (e) => e.preventDefault());
});
$('panel-toggle').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

const statsEl = $('stats');
const fmtVol = (v: number) => (v > 1e6 ? `${(v / 1e6).toFixed(2)} Mm³` : v > 1e3 ? `${(v / 1e3).toFixed(1)} k m³` : `${v.toFixed(1)} m³`);
const fmtTime = (s: number) => (s < 120 ? `${s.toFixed(0)} s` : s < 7200 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(2)} h`);
function renderStats(s: SimStats) {
  const g = s.grid;
  statsEl.innerHTML = [
    `<b>${s.status}</b>`,
    g ? `grid ${g.nx}×${g.ny} · ${g.dx.toFixed(2)} m cells · DEM z${g.demZoom}` : '',
    `obstacles: ${s.obstacles}`,
    `sim time ${fmtTime(s.simTime)} · ${s.speed.toFixed(1)}× real · ${s.substeps} substeps (dt ${s.dt.toFixed(3)} s)`,
    `max depth ${s.maxDepth.toFixed(2)} m · volume ${fmtVol(s.volume)}`,
    map.getZoom() < 12 ? '<span class="warn">zoom to z12+ for meaningful results</span>' : '',
  ].filter(Boolean).join('<br>');
}
layer.onStats = renderStats;
setInterval(() => renderStats(layer.stats), 250);

function showError(msg: string) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = false;
}

setMode(params.mode);
(window as unknown as { waterSim: unknown }).waterSim = { map, layer, params };
