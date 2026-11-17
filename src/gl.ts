export type GL = WebGL2RenderingContext;

export function compile(gl: GL, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`shader compile failed: ${log}\n${src}`);
    }
    return s;
  };
  const p = gl.createProgram()!;
  const v = mk(gl.VERTEX_SHADER, vs);
  const f = mk(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

/** Program wrapper with cached uniform locations. */
export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: GL, vs: string, fs: string) {
    this.prog = compile(gl, vs, fs);
  }
  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }
  loc(name: string) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.locs.get(name)!;
  }
  i(name: string, v: number) { this.gl.uniform1i(this.loc(name), v); return this; }
  f(name: string, v: number) { this.gl.uniform1f(this.loc(name), v); return this; }
  f2(name: string, a: number, b: number) { this.gl.uniform2f(this.loc(name), a, b); return this; }
  f4(name: string, a: number, b: number, c: number, d: number) { this.gl.uniform4f(this.loc(name), a, b, c, d); return this; }
  i2(name: string, a: number, b: number) { this.gl.uniform2i(this.loc(name), a, b); return this; }
  m4(name: string, m: ArrayLike<number>) { this.gl.uniformMatrix4fv(this.loc(name), false, Float32Array.from(m)); return this; }
  tex(name: string, unit: number, t: WebGLTexture) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, t);
    this.gl.uniform1i(this.loc(name), unit);
    return this;
  }
  dispose() { this.gl.deleteProgram(this.prog); }
}

export interface TexOpts {
  internal: number;
  format: number;
  type: number;
  filter?: number;
  data?: ArrayBufferView | null;
}

export function createTexture(gl: GL, w: number, h: number, o: TexOpts): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  const filter = o.filter ?? gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, o.internal, w, h, 0, o.format, o.type, o.data ?? null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  return t;
}

export const rgba32f = (gl: GL, w: number, h: number, data: Float32Array | null = null) =>
  createTexture(gl, w, h, { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, data });

/** A texture with a framebuffer attached, used as a render target. */
export class Target {
  readonly tex: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  constructor(private gl: GL, readonly w: number, readonly h: number, tex?: WebGLTexture) {
    this.tex = tex ?? rgba32f(gl, w, h);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
  }
  bind() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.w, this.h);
  }
  dispose() {
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteTexture(this.tex);
  }
}

/** Two render targets swapped after every pass. */
export class PingPong {
  a: Target;
  b: Target;
  constructor(gl: GL, w: number, h: number, init?: Float32Array) {
    this.a = new Target(gl, w, h, init ? rgba32f(gl, w, h, init) : undefined);
    this.b = new Target(gl, w, h);
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { [this.a, this.b] = [this.b, this.a]; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** 4x4 column-major matrix multiply (doubles), a*b. */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
