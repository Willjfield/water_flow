import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type LngLat, type Map as MlMap } from 'maplibre-gl';
import { type GL, PingPong, Program, Target, createTexture, mul4 } from './gl';
import { type Grid, computeGrid, gridStillValid, tileInCells } from './grid';
import { type DemSampler, type DemTile, demSampler, loadDem } from './elevation';
import { type ObstacleRaster, type ObstacleSource, rasterizeObstacles } from './obstacles';
import * as S from './shaders';

export type Mode = 'rain' | 'pour' | 'box';

export interface SimParams {
  mode: Mode;
  rainMmPerHr: number;
  pourMmPerS: number;
  brushRadiusM: number;
  /** simulated seconds per real second */
  simSpeed: number;
  infilMmPerHr: number;
  manningN: number;
  minDepthM: number;
  opacity: number;
  particles: boolean;
  showObstacles: boolean;
  seaSink: boolean;
  keepWater: boolean;
  openBridges: boolean;
  paused: boolean;
  cellPx: number;
}

export interface SimStats {
  status: string;
  grid?: { nx: number; ny: number; dx: number; demZoom: number };
  obstacles: string;
  substeps: number;
  dt: number;
  speed: number;
  maxDepth: number;
  volume: number;
  wetCells: number;
  simTime: number;
}

interface PendingGrid {
  grid: Grid;
  dem: DemTile[];
  demZoom: number;
  sampler: DemPromise;
  obs: ObstacleRaster | null;
}

type DemPromise = Promise<{ sampler: DemSampler; zoom: number } | null>;

const G = 9.81;
const CFL = 0.6;
const MAX_SUBSTEPS = 48;
const PARTICLE_TEX = 256;
const PARTICLE_MAX_AGE = 240;

export class WaterLayer implements CustomLayerInterface {
  readonly id = 'water-sim';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map!: MlMap;
  private gl!: GL;
  private progs!: Record<'dem' | 'bed' | 'flux' | 'depth' | 'reduce' | 'resample' | 'pupdate' | 'pdraw' | 'water', Program>;
  private triVao!: WebGLVertexArrayObject;
  private quadVao!: WebGLVertexArrayObject;
  private emptyVao!: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];

  private grid: Grid | null = null;
  private demZoom = 0;
  private state: PingPong | null = null;
  private dem: Target | null = null;
  private bed: Target | null = null;
  private obsTex: WebGLTexture | null = null;
  private dummyObs!: WebGLTexture;
  private ovTex: WebGLTexture | null = null;
  private dummyOv!: WebGLTexture;
  private sampler: DemPromise = Promise.resolve(null);
  private reduce: Target[] = [];
  private particles: PingPong | null = null;
  private pbo!: WebGLBuffer;
  private fence: WebGLSync | null = null;
  private readback = new Float32Array(4);

  private pending: PendingGrid | null = null;
  private pendingObs: { grid: Grid; data: ObstacleRaster | null } | null = null;
  private bedDirty = false;
  private clearRequested = false;
  /** Stats no longer describe the water state; keep drawing (even when paused) until a fresh readback lands. */
  private statsDirty = false;
  private gen = 0;
  private obsGen = 0;
  private lastFrame = 0;
  private cmax = 0;
  private hmax = 0;
  private dtPrev = 0;
  private seed = 0;
  private moveTimer: number | undefined;

  pourAt: LngLat | null = null;
  /** opposite corners of the box that pours in 'box' mode */
  pourBox: [LngLat, LngLat] | null = null;
  obstacleSource: ObstacleSource | null = null;
  stats: SimStats = { status: 'starting', obstacles: 'off', substeps: 0, dt: 0, speed: 0, maxDepth: 0, volume: 0, wetCells: 0, simTime: 0 };
  onStats?: (s: SimStats) => void;
  onError?: (msg: string) => void;

  constructor(public params: SimParams, private resolveObstacleSource: (g: Grid) => Promise<ObstacleSource | null>) {}

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error('WebGL2 required');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      this.onError?.('This GPU/browser lacks EXT_color_buffer_float (float render targets); the simulation cannot run.');
      return;
    }
    const P = (vs: string, fs: string) => new Program(gl, vs, fs);
    this.progs = {
      dem: P(S.DEM_VS, S.DEM_FS),
      bed: P(S.FULLSCREEN_VS, S.BED_FS),
      flux: P(S.FULLSCREEN_VS, S.FLUX_FS),
      depth: P(S.FULLSCREEN_VS, S.DEPTH_FS),
      reduce: P(S.FULLSCREEN_VS, S.REDUCE_FS),
      resample: P(S.FULLSCREEN_VS, S.RESAMPLE_FS),
      pupdate: P(S.FULLSCREEN_VS, S.PARTICLE_UPDATE_FS),
      pdraw: P(S.PARTICLE_VS, S.PARTICLE_FS),
      water: P(S.WATER_VS, S.WATER_FS),
    };
    const vao = (data: number[]) => {
      const v = gl.createVertexArray()!;
      gl.bindVertexArray(v);
      const b = gl.createBuffer()!;
      this.buffers.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      return v;
    };
    this.triVao = vao([-1, -1, 3, -1, -1, 3]);
    this.quadVao = vao([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    this.emptyVao = gl.createVertexArray()!;
    this.dummyObs = createTexture(gl, 1, 1, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: new Uint8Array([0, 128, 0, 255]) });
    this.dummyOv = createTexture(gl, 1, 1, { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, data: new Float32Array([1e9]) });
    this.pbo = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const init = new Float32Array(PARTICLE_TEX * PARTICLE_TEX * 4).map((_, i) => (i % 4 === 2 ? PARTICLE_MAX_AGE + 1 : 0));
    this.particles = new PingPong(gl, PARTICLE_TEX, PARTICLE_TEX, init);

    map.on('moveend', this.onMoveEnd);
    this.rebuild();
  }

  onRemove() {
    this.map.off('moveend', this.onMoveEnd);
    const gl = this.gl;
    this.state?.dispose(); this.dem?.dispose(); this.bed?.dispose(); this.particles?.dispose();
    this.reduce.forEach((r) => r.dispose());
    if (this.obsTex) gl.deleteTexture(this.obsTex);
    if (this.ovTex) gl.deleteTexture(this.ovTex);
    gl.deleteTexture(this.dummyObs);
    gl.deleteTexture(this.dummyOv);
    Object.values(this.progs ?? {}).forEach((p) => p.dispose());
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteBuffer(this.pbo);
  }

  private onMoveEnd = () => {
    clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => {
      if (!this.grid || !this.params.keepWater || !gridStillValid(this.map, this.grid, this.params.cellPx)) this.rebuild();
    }, 150);
  };

  /** Recompute the grid for the current view and (re)load elevation + obstacles. */
  async rebuild() {
    const gen = ++this.gen;
    const grid = computeGrid(this.map, this.params.cellPx);
    this.setStatus('loading elevation…');
    try {
      const demP = loadDem(grid);
      const sampler: DemPromise = demP.then((d) => {
        const s = demSampler(d.tiles);
        return s ? { sampler: s, zoom: d.zoom } : null;
      }).catch(() => null);
      const [dem, obs] = await Promise.all([demP, this.loadObstacles(grid, sampler)]);
      if (gen !== this.gen) return;
      if (!dem.tiles.length) throw new Error('no Mapterhorn tiles available here');
      this.pending = { grid, dem: dem.tiles, demZoom: dem.zoom, sampler, obs };
      this.setStatus(dem.missing ? `running (${dem.missing} DEM tiles missing)` : 'running');
      this.map.triggerRepaint();
    } catch (e) {
      if (gen === this.gen) this.setStatus(`error: ${(e as Error).message}`);
    }
  }

  /** Re-rasterise obstacles for the current grid (e.g. after switching source). */
  async reloadObstacles() {
    if (!this.grid) return;
    const grid = this.grid;
    const data = await this.loadObstacles(grid, this.sampler);
    if (grid === this.grid) {
      this.pendingObs = { grid, data };
      this.map.triggerRepaint();
    }
  }

  private async loadObstacles(grid: Grid, dem: DemPromise): Promise<ObstacleRaster | null> {
    const gen = ++this.obsGen;
    const src = await this.resolveObstacleSource(grid).catch(() => null);
    this.obstacleSource = src;
    if (!src) {
      this.stats.obstacles = 'off';
      return null;
    }
    this.stats.obstacles = `loading ${src.name}…`;
    try {
      const r = await rasterizeObstacles(grid, src, dem);
      const ov = r?.bedOverride;
      const opened = ov ? ` · opened ${ov.bridges} bridge crossings, ${ov.burned} channels` : '';
      if (gen === this.obsGen) this.stats.obstacles = r ? `${src.name}: ${r.features} features / ${r.tiles} tiles${opened}` : `${src.name}: zoom in (cells > 12 m)`;
      return r;
    } catch (e) {
      this.stats.obstacles = `error: ${(e as Error).message}`;
      return null;
    }
  }

  reset() {
    this.clearRequested = true;
    this.stats.simTime = 0;
    this.map.triggerRepaint();
  }

  markBedDirty() {
    this.bedDirty = true;
    this.map.triggerRepaint();
  }

  private setStatus(s: string) {
    this.stats.status = s;
    this.onStats?.(this.stats);
  }

  // ---------------------------------------------------------------- GPU passes

  private fullscreen(target: Target) {
    target.bind();
    this.gl.bindVertexArray(this.triVao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  private applyPending(p: PendingGrid) {
    const gl = this.gl;
    const g = p.grid;

    const dem = new Target(gl, g.nx, g.ny, createTexture(gl, g.nx, g.ny, { internal: gl.R32F, format: gl.RED, type: gl.FLOAT }));
    dem.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const tileTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tileTex);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const prog = this.progs.dem.use().i('u_tile', 0).f2('u_gridSize', g.nx, g.ny);
    gl.bindVertexArray(this.quadVao);
    for (const t of p.dem) {
      gl.bindTexture(gl.TEXTURE_2D, tileTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, t.image);
      const r = tileInCells(g, t.req), s = tileInCells(g, t.src);
      prog.f2('u_origin', r.ox, r.oy).f('u_extent', r.size).f2('u_srcOrigin', s.ox, s.oy).f('u_srcExtent', s.size);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.deleteTexture(tileTex);

    const state = new PingPong(gl, g.nx, g.ny);
    if (this.state && this.grid && this.params.keepWater) {
      const o = this.grid;
      this.progs.resample.use().tex('u_old', 0, this.state.read.tex).i2('u_oldSize', o.nx, o.ny)
        .f2('u_off', (g.x0 - o.x0) / o.cell, (g.y0 - o.y0) / o.cell).f('u_scale', g.cell / o.cell);
      this.fullscreen(state.read);
    } else {
      state.read.bind();
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    this.state?.dispose(); this.dem?.dispose(); this.bed?.dispose();
    this.reduce.forEach((r) => r.dispose());
    this.state = state;
    this.dem = dem;
    this.bed = new Target(gl, g.nx, g.ny);
    this.grid = g;
    this.demZoom = p.demZoom;
    this.sampler = p.sampler;
    this.setObstacles(p.obs);
    this.reduce = [];
    for (let w = g.nx, h = g.ny; ;) {
      w = Math.ceil(w / 4); h = Math.ceil(h / 4);
      this.reduce.push(new Target(gl, w, h));
      if (w === 1 && h === 1) break;
    }
    this.resetParticles();
    this.stats.grid = { nx: g.nx, ny: g.ny, dx: g.dx, demZoom: p.demZoom };
  }

  private setObstacles(r: ObstacleRaster | null) {
    const gl = this.gl, g = this.grid!;
    if (this.obsTex) gl.deleteTexture(this.obsTex);
    if (this.ovTex) gl.deleteTexture(this.ovTex);
    this.obsTex = r ? createTexture(gl, g.nx, g.ny, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: r.data }) : null;
    const ov = r?.bedOverride?.bed;
    this.ovTex = ov ? createTexture(gl, g.nx, g.ny, { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, data: ov }) : null;
    this.bedDirty = true;
  }

  private computeBed() {
    this.progs.bed.use().tex('u_dem', 0, this.dem!.tex).tex('u_obs', 1, this.obsTex ?? this.dummyObs)
      .tex('u_ov', 2, this.ovTex ?? this.dummyOv)
      .f('u_useObs', this.obsTex ? 1 : 0).f('u_useOv', this.ovTex && this.params.openBridges ? 1 : 0).f('u_baseN', this.params.manningN);
    this.fullscreen(this.bed!);
    this.bedDirty = false;
  }

  private resetParticles() {
    const p = this.particles!;
    for (const t of [p.a, p.b]) {
      t.bind();
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
  }

  private bindCell(p: Program, stateTex: WebGLTexture) {
    const g = this.grid!;
    return p.use().tex('u_state', 0, stateTex).tex('u_bed', 1, this.bed!.tex).i2('u_size', g.nx, g.ny);
  }

  private step(frameDt: number) {
    const g = this.grid!, st = this.state!, p = this.params;
    const budget = frameDt * p.simSpeed;
    // CFL from the (slightly lagged) GPU reduction, floored so freshly poured water can't outrun it.
    const c = Math.max(this.cmax, Math.sqrt(G * Math.max(this.hmax * 1.5, 0.3)));
    let dtCfl = (CFL * g.dx) / c;
    if (this.dtPrev > 0) dtCfl = Math.min(dtCfl, this.dtPrev * 1.25);
    let n = Math.max(1, Math.ceil(budget / dtCfl));
    let dt = budget / n;
    if (n > MAX_SUBSTEPS) { n = MAX_SUBSTEPS; dt = dtCfl; }
    this.dtPrev = dt;

    const rain = p.mode === 'rain' ? p.rainMmPerHr / 1000 / 3600 : 0;
    let pour: [number, number, number, number] = [0, 0, 0, 0];
    if (p.mode === 'pour' && this.pourAt) {
      const m = MercatorCoordinate.fromLngLat(this.pourAt);
      pour = [(m.x - g.x0) / g.cell, (m.y - g.y0) / g.cell, Math.max(1.5, p.brushRadiusM / g.dx), p.pourMmPerS / 1000];
    }
    let box: [number, number, number, number] = [0, 0, 0, 0], boxRate = 0;
    if (p.mode === 'box' && this.pourBox) {
      const [a, b] = this.pourBox.map((ll) => MercatorCoordinate.fromLngLat(ll)).map((m) => [(m.x - g.x0) / g.cell, (m.y - g.y0) / g.cell]);
      // grow sub-cell boxes to one cell so a tiny box still pours
      const lo = [0, 1].map((k) => Math.min(a[k], b[k])), hi = [0, 1].map((k) => Math.max(a[k], b[k]));
      for (const k of [0, 1]) if (hi[k] - lo[k] < 1) { const mid = (lo[k] + hi[k]) / 2; lo[k] = mid - 0.5; hi[k] = mid + 0.5; }
      box = [lo[0], lo[1], hi[0], hi[1]];
      boxRate = p.pourMmPerS / 1000;
    }
    for (let i = 0; i < n; i++) {
      this.bindCell(this.progs.flux, st.read.tex).f('u_dt', dt).f('u_dx', g.dx).f('u_theta', 0.8).f('u_vmax', 15);
      this.fullscreen(st.write);
      st.swap();
      this.bindCell(this.progs.depth, st.read.tex).f('u_dt', dt).f('u_dx', g.dx).f('u_rain', rain)
        .f4('u_pour', ...pour).f4('u_box', ...box).f('u_boxRate', boxRate).f('u_infil', p.infilMmPerHr / 1000 / 3600).f('u_seaSink', p.seaSink ? 1 : 0);
      this.fullscreen(st.write);
      st.swap();
    }
    this.stats.substeps = n;
    this.stats.dt = dt;
    this.stats.speed = (n * dt) / frameDt;
    this.stats.simTime += n * dt;
    return n * dt;
  }

  private invalidateStats() {
    if (this.fence) { this.gl.deleteSync(this.fence); this.fence = null; }
    this.statsDirty = true;
  }

  private reduceAndRead() {
    const gl = this.gl, g = this.grid!;
    if (this.fence) {
      if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      gl.deleteSync(this.fence);
      this.fence = null;
      this.statsDirty = false;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readback);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const [cmax, hmax, sum, wet] = this.readback;
      if (Number.isFinite(cmax)) { this.cmax = cmax; this.hmax = hmax; }
      Object.assign(this.stats, { maxDepth: hmax, volume: sum * g.dx * g.dx, wetCells: wet });
      this.onStats?.(this.stats);
      return;
    }
    let src = this.state!.read.tex, sw = g.nx, sh = g.ny, first = 1;
    for (const t of this.reduce) {
      this.progs.reduce.use().tex('u_src', 0, src).i2('u_srcSize', sw, sh).i('u_first', first);
      this.fullscreen(t);
      src = t.tex; sw = t.w; sh = t.h; first = 0;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  private updateParticles(simSeconds: number) {
    const g = this.grid!, p = this.particles!;
    this.bindCell(this.progs.pupdate, this.state!.read.tex).tex('u_particles', 2, p.read.tex)
      .f('u_advect', simSeconds / g.dx).f('u_minDepth', Math.max(this.params.minDepthM, 0.005))
      .f('u_seed', (this.seed = (this.seed + 1) % 1000)).f('u_maxAge', PARTICLE_MAX_AGE);
    this.fullscreen(p.write);
    p.swap();
  }

  prerender(ctx: WebGLRenderingContext | WebGL2RenderingContext) {
    const gl = this.gl;
    if (!this.progs || ctx !== gl) return;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    try {
      if (this.pending) { this.applyPending(this.pending); this.pending = null; this.invalidateStats(); }
      if (!this.grid || !this.state) return;
      if (this.pendingObs) {
        if (this.pendingObs.grid === this.grid) this.setObstacles(this.pendingObs.data);
        this.pendingObs = null;
      }
      if (this.clearRequested) {
        for (const t of [this.state.a, this.state.b]) { t.bind(); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
        this.resetParticles();
        this.cmax = this.hmax = 0;
        this.clearRequested = false;
        this.invalidateStats();
      }
      if (this.bedDirty) this.computeBed();
      const now = performance.now();
      const frameDt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 1 / 20) : 1 / 60;
      this.lastFrame = now;
      let simSeconds = 0;
      if (!this.params.paused) simSeconds = this.step(frameDt);
      this.reduceAndRead();
      if (this.params.particles) this.updateParticles(simSeconds);
    } finally {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  render(ctx: WebGLRenderingContext | WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const gl = this.gl;
    if (!this.progs || !this.grid || !this.state || !this.bed || ctx !== gl) return;
    const g = this.grid;
    const gridM = [g.nx * g.cell, 0, 0, 0, 0, g.ny * g.cell, 0, 0, 0, 0, 1, 0, g.x0, g.y0, 0, 1];
    const m = mul4(opts.defaultProjectionData.mainMatrix as ArrayLike<number>, gridM);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.bindCell(this.progs.water, this.state.read.tex).m4('u_matrix', m).f2('u_gridSize', g.nx, g.ny)
      .f('u_minDepth', this.params.minDepthM).f('u_opacity', this.params.opacity).f('u_showObs', this.params.showObstacles ? 1 : 0);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (this.params.particles && this.particles) {
      this.progs.pdraw.use().tex('u_particles', 0, this.particles.read.tex).f2('u_gridSize', g.nx, g.ny).m4('u_matrix', m)
        .f('u_pointSize', 1.6 * devicePixelRatio).f('u_maxAge', PARTICLE_MAX_AGE);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.POINTS, 0, PARTICLE_TEX * PARTICLE_TEX);
    }
    gl.bindVertexArray(null);
    if (!this.params.paused || this.pending || this.statsDirty) this.map.triggerRepaint();
  }

  get demZoomLevel() { return this.demZoom; }
}

