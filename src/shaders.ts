// GLSL ES 3.00 sources. Grid convention: texel (i, j) is cell column i, row j,
// rows increase southward (mercator y). Face fluxes are stored per cell:
// state.g = qx through the cell's east face (+ = eastward),
// state.b = qy through the cell's south face (+ = southward). Units m^2/s.

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/** Full-screen triangle; fragment shaders work in cell space via gl_FragCoord. */
export const FULLSCREEN_VS = `${HEAD}
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const CELL_HELPERS = /* glsl */ `
uniform sampler2D u_state;
uniform sampler2D u_bed;
uniform ivec2 u_size;
const float G = 9.81;
bool inside(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < u_size.x && c.y < u_size.y; }
vec4 S(ivec2 c) { return texelFetch(u_state, c, 0); }
vec4 B(ivec2 c) { return texelFetch(u_bed, c, 0); }
`;

/** Draws one Terrarium tile (possibly an overzoomed parent) into the R32F elevation target. */
export const DEM_VS = `${HEAD}
layout(location = 0) in vec2 a_pos;
uniform vec2 u_origin;   // requested tile origin in cells
uniform float u_extent;  // requested tile size in cells
uniform vec2 u_gridSize;
void main() {
  vec2 cell = u_origin + a_pos * u_extent;
  gl_Position = vec4(cell / u_gridSize * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const DEM_FS = `${HEAD}
uniform sampler2D u_tile;
uniform vec2 u_srcOrigin;  // origin of the tile actually fetched, in cells
uniform float u_srcExtent;
out vec4 o;
float dec(ivec2 p, ivec2 n) {
  vec3 c = texelFetch(u_tile, clamp(p, ivec2(0), n - 1), 0).rgb * 255.0;
  return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0;
}
void main() {
  ivec2 n = textureSize(u_tile, 0);
  vec2 tp = (gl_FragCoord.xy - u_srcOrigin) / u_srcExtent * vec2(n) - 0.5;
  ivec2 i = ivec2(floor(tp));
  vec2 f = tp - floor(tp);
  float e = mix(mix(dec(i, n), dec(i + ivec2(1, 0), n), f.x),
                mix(dec(i + ivec2(0, 1), n), dec(i + ivec2(1, 1), n), f.x), f.y);
  o = vec4(e, 0.0, 0.0, 1.0);
}
`;

/** bed = (effective bed z, blocked, manning n, raw DEM) */
export const BED_FS = `${HEAD}
uniform sampler2D u_dem;
uniform sampler2D u_obs;
uniform sampler2D u_ov;  // absolute bed override (bridge breaching); huge = none
uniform float u_useObs;
uniform float u_useOv;
uniform float u_maxCut;
uniform float u_baseN;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float dem = texelFetch(u_dem, c, 0).r;
  float base = u_useOv > 0.5 ? max(min(dem, texelFetch(u_ov, c, 0).r), dem - u_maxCut) : dem;
  vec4 ob = texelFetch(u_obs, c, 0) * 255.0;
  float blocked = u_useObs * step(127.5, ob.r);
  float dz = u_useObs * (ob.g - 128.0) * 0.05;
  float n = (u_useObs > 0.5 && ob.b > 0.5) ? ob.b / 1000.0 : u_baseN;
  o = vec4(base + dz, blocked, n, dem);
}
`;

/** Local-inertial momentum update (Bates 2010 / de Almeida 2012 q-centred scheme). */
export const FLUX_FS = `${HEAD}
${CELL_HELPERS}
uniform float u_dt;
uniform float u_dx;
uniform float u_theta;
uniform float u_vmax;
out vec4 o;

float outfall(float h, float lim) { return h < 1e-4 ? 0.0 : min(h * sqrt(G * h), h * lim); }

float faceFlux(ivec2 c0, ivec2 c1, float q, float qUp, float qDown) {
  vec4 s0 = S(c0), b0 = B(c0);
  float lim = 0.25 * u_dx / u_dt;
  if (b0.g > 0.5) return 0.0;
  if (!inside(c1)) return outfall(s0.r, lim);
  vec4 s1 = S(c1), b1 = B(c1);
  if (b1.g > 0.5) return 0.0;
  float eta0 = s0.r + b0.r, eta1 = s1.r + b1.r;
  float hf = max(eta0, eta1) - max(b0.r, b1.r);
  if (hf <= 1e-4) return 0.0;
  float n = 0.5 * (b0.b + b1.b);
  float qa = u_theta * q + 0.5 * (1.0 - u_theta) * (qUp + qDown);
  float qn = (qa - G * hf * u_dt * (eta1 - eta0) / u_dx)
           / (1.0 + G * u_dt * n * n * abs(q) / pow(hf, 7.0 / 3.0));
  qn = clamp(qn, -u_vmax * hf, u_vmax * hf);
  // positivity: a face may drain at most 1/4 of its upwind cell per step
  return qn > 0.0 ? min(qn, s0.r * lim) : max(qn, -s1.r * lim);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = S(c);
  ivec2 ex = ivec2(1, 0), ey = ivec2(0, 1);
  float qxW = inside(c - ex) ? S(c - ex).g : s.g;
  float qxE = inside(c + ex) ? S(c + ex).g : s.g;
  float qyN = inside(c - ey) ? S(c - ey).b : s.b;
  float qyS = inside(c + ey) ? S(c + ey).b : s.b;
  float qx = faceFlux(c, c + ex, s.g, qxW, qxE);
  float qy = faceFlux(c, c + ey, s.b, qyN, qyS);
  o = vec4(s.r, qx, qy, s.a);
}
`;

/** Continuity update + sources/sinks. */
export const DEPTH_FS = `${HEAD}
${CELL_HELPERS}
uniform float u_dt;
uniform float u_dx;
uniform float u_rain;     // m/s over the whole grid
uniform vec4 u_pour;      // xy centre (cells), z radius (cells), w rate (m/s)
uniform vec4 u_box;       // xy min, zw max (cells)
uniform float u_boxRate;  // m/s inside u_box
uniform float u_infil;    // m/s
uniform float u_seaSink;  // 1 = cells with DEM <= 0 drain
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = S(c), b = B(c);
  float lim = 0.25 * u_dx / u_dt;
  float out0 = (b.g > 0.5 || s.r < 1e-4) ? 0.0 : min(s.r * sqrt(G * s.r), s.r * lim);
  ivec2 ex = ivec2(1, 0), ey = ivec2(0, 1);
  float qW = inside(c - ex) ? S(c - ex).g : -out0;
  float qN = inside(c - ey) ? S(c - ey).b : -out0;
  float h = s.r + u_dt / u_dx * (qW - s.g + qN - s.b);
  float src = u_rain;
  if (u_pour.w > 0.0) {
    float d = distance(vec2(c) + 0.5, u_pour.xy);
    src += u_pour.w * (1.0 - smoothstep(0.6 * u_pour.z, u_pour.z, d));
  }
  if (u_boxRate > 0.0) {
    vec2 p = vec2(c) + 0.5;
    if (all(greaterThanEqual(p, u_box.xy)) && all(lessThanEqual(p, u_box.zw))) src += u_boxRate;
  }
  h += u_dt * (src - u_infil);
  if (b.g > 0.5 || (u_seaSink > 0.5 && b.a <= 0.0)) h = 0.0;
  o = vec4(max(h, 0.0), s.g, s.b, s.a);
}
`;

/** 4x4 block reduction: (max wave speed, max depth, sum depth, wet cell count). */
export const REDUCE_FS = `${HEAD}
uniform sampler2D u_src;
uniform ivec2 u_srcSize;
uniform int u_first;
out vec4 o;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 4;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    ivec2 p = base + ivec2(x, y);
    if (p.x >= u_srcSize.x || p.y >= u_srcSize.y) continue;
    vec4 v = texelFetch(u_src, p, 0);
    if (u_first == 1) {
      float h = v.r;
      float u = h > 1e-3 ? max(abs(v.g), abs(v.b)) / h : 0.0;
      v = vec4(sqrt(9.81 * h) + u, h, h, h > 1e-3 ? 1.0 : 0.0);
    }
    acc = vec4(max(acc.x, v.x), max(acc.y, v.y), acc.z + v.z, acc.w + v.w);
  }
  o = acc;
}
`;

/** Carry water state from the previous grid to a new one (aligned power-of-two cells). */
export const RESAMPLE_FS = `${HEAD}
uniform sampler2D u_old;
uniform ivec2 u_oldSize;
uniform vec2 u_off;    // new grid origin in old-cell units
uniform float u_scale; // new cell / old cell
out vec4 o;
vec4 get(ivec2 p) {
  return (p.x >= 0 && p.y >= 0 && p.x < u_oldSize.x && p.y < u_oldSize.y) ? texelFetch(u_old, p, 0) : vec4(0.0);
}
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  if (u_scale <= 1.0) {
    o = get(ivec2(floor((c + 0.5) * u_scale + u_off)));
    return;
  }
  ivec2 start = ivec2(floor(c * u_scale + u_off + 1e-3));
  // Average k*k old cells; beyond 16x16 take an evenly strided 16x16 subsample.
  int k = int(u_scale + 0.5);
  int n = min(k, 16);
  float stride = float(k) / float(n);
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 16; y++) {
    if (y >= n) break;
    for (int x = 0; x < 16; x++) {
      if (x >= n) break;
      acc += get(start + ivec2(floor((vec2(x, y) + 0.5) * stride)));
    }
  }
  o = acc / float(n * n);
}
`;

export const PARTICLE_UPDATE_FS = `${HEAD}
${CELL_HELPERS}
uniform sampler2D u_particles;
uniform float u_advect;   // simulated seconds advected this frame / dx  (cells per (m/s))
uniform float u_minDepth;
uniform float u_seed;
uniform float u_maxAge;
out vec4 o;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 p = texelFetch(u_particles, ivec2(gl_FragCoord.xy), 0);
  ivec2 c = ivec2(floor(p.xy));
  bool ok = inside(c) && p.z < u_maxAge;
  vec4 s = ok ? S(c) : vec4(0.0);
  vec2 vel = vec2(0.0);
  if (ok && s.r >= u_minDepth) {
    ivec2 ex = ivec2(1, 0), ey = ivec2(0, 1);
    float qW = inside(c - ex) ? S(c - ex).g : s.g;
    float qN = inside(c - ey) ? S(c - ey).b : s.b;
    vel = 0.5 * vec2(qW + s.g, qN + s.b) / s.r;
  }
  float speed = length(vel);
  if (!ok || s.r < u_minDepth || speed < 1e-3) {
    vec2 r = vec2(hash(gl_FragCoord.xy + u_seed), hash(gl_FragCoord.yx * 1.7 + u_seed * 0.37));
    o = vec4(r * vec2(u_size), hash(gl_FragCoord.xy * 3.1 + u_seed) * u_maxAge * 0.5, 0.0);
    return;
  }
  vec2 step_ = vel * u_advect;
  float m = max(abs(step_.x), abs(step_.y));
  if (m > 1.5) step_ *= 1.5 / m;
  o = vec4(p.xy + step_, p.z + 1.0, speed);
}
`;

export const PARTICLE_VS = `${HEAD}
uniform sampler2D u_particles;
uniform vec2 u_gridSize;
uniform mat4 u_matrix;
uniform float u_pointSize;
uniform float u_maxAge;
out float v_alpha;
void main() {
  ivec2 n = textureSize(u_particles, 0);
  vec4 p = texelFetch(u_particles, ivec2(gl_VertexID % n.x, gl_VertexID / n.x), 0);
  float age = p.z / u_maxAge;
  v_alpha = p.w > 0.0 ? clamp(0.25 + p.w / 1.5, 0.0, 1.0) * smoothstep(0.0, 0.1, age) * (1.0 - smoothstep(0.8, 1.0, age)) : 0.0;
  gl_Position = v_alpha > 0.0 ? u_matrix * vec4(p.xy / u_gridSize, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = u_pointSize;
}
`;

export const PARTICLE_FS = `${HEAD}
in float v_alpha;
out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = v_alpha * (1.0 - smoothstep(0.3, 0.5, d)) * 0.9;
  o = vec4(vec3(1.0) * a, a);
}
`;

export const WATER_VS = `${HEAD}
layout(location = 0) in vec2 a_pos;
uniform mat4 u_matrix;
uniform vec2 u_gridSize;
out vec2 v_cell;
void main() {
  v_cell = a_pos * u_gridSize;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}
`;

export const WATER_FS = `${HEAD}
${CELL_HELPERS}
in vec2 v_cell;
uniform float u_minDepth;
uniform float u_opacity;
uniform float u_showObs;
out vec4 o;
float H(ivec2 c) { c = clamp(c, ivec2(0), u_size - 1); return S(c).r; }
void main() {
  vec2 p = v_cell - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - floor(p);
  float h = mix(mix(H(i), H(i + ivec2(1, 0)), f.x), mix(H(i + ivec2(0, 1)), H(i + ivec2(1, 1)), f.x), f.y);
  ivec2 c = clamp(ivec2(floor(v_cell)), ivec2(0), u_size - 1);
  vec4 col = vec4(0.0);
  if (u_showObs > 0.5) {
    vec4 b = B(c);
    float dz = b.r - b.a;
    if (b.g > 0.5) col = vec4(0.85, 0.2, 0.2, 1.0) * 0.55;
    else if (dz > 0.05) col = vec4(1.0, 0.6, 0.1, 1.0) * 0.45 * clamp(dz / 1.0, 0.4, 1.0);
    else if (dz < -0.05) col = vec4(0.1, 0.9, 0.8, 1.0) * 0.45;
  }
  if (h >= u_minDepth) {
    vec4 s = S(c);
    float speed = s.r > 1e-3 ? length(s.gb) / s.r : 0.0;
    float t = 1.0 - exp(-h / 0.6);
    vec3 rgb = mix(vec3(0.2, 0.55, 0.95), vec3(0.02, 0.12, 0.42), t);
    rgb = mix(rgb, vec3(0.85, 0.95, 1.0), 0.35 * smoothstep(0.5, 3.0, speed));
    float a = u_opacity * mix(0.6, 0.95, t) * smoothstep(u_minDepth, u_minDepth * 1.5, h);
    col = vec4(rgb * a, a) + col * (1.0 - a);
  }
  if (col.a <= 0.0) discard;
  o = col;
}
`;
