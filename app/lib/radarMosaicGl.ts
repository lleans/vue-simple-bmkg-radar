// WebGL2 renderer for the radar mosaic: every visible station is composed in
// one fragment-shader pass over a full-viewport quad, instead of one
// drawImage per station on the Canvas2D overlay.
//
// Data flow:
//   - Each station frame is converted once per upload, on the CPU, from RGBA
//     to one palette index per pixel (radarMosaic.ts). The indices go into a
//     TEXTURE_2D_ARRAY of R8 layers, all at one common edge E, one layer per
//     frame URL.
//   - A 256x1 RGBA lookup texture maps an index to its colour.
//   - The shader loops over the stations (uniforms for centre, radius, strength
//     and layer), takes the strongest echo per pixel and writes
//     premultiplied colour.
//   - Alpha and colour come from separate weightings of the same four taps
//     (echoEdgeSample in radarMosaic.ts). Alpha is the bilinear average of echo
//     presence through a narrow smoothstep (ECHO_EDGE_BAND), so the edge is
//     sharp and follows the bilinear contour. The colour is the index
//     averaged over the echo taps only, rounded to a palette entry, so no-echo
//     never pulls a colour toward zero and colours are never blended.
//
// The per-pixel rule is documented in radarMosaic.ts; mosaicPixel there is the
// CPU reference for the shader below.
//
// Reading frames: the frame pixels are read back with getImageData, so the
// frame must come from a CORS-enabled response. A tainted frame makes
// getImageData throw; draw() then returns false and the caller paints the
// Canvas2D overlay instead.

import {
  MOSAIC_ALPHA,
  ECHO_EDGE_BAND,
  MOSAIC_MAX_STATIONS,
  buildPaletteLut,
  createColourIndexer,
  paletteIndicesFromRgba,
  type ColourIndexer,
} from './radarMosaic'

export interface MosaicDisc {
  /** Frame URL: the cache key for its GPU layer. */
  url: string
  bitmap: CanvasImageSource
  /** Station centre and frame radius, in device pixels, y down. */
  cx: number
  cy: number
  radius: number
  /** Strength (1 undimmed, DIMMED_STRENGTH dimmed). */
  strength: number
}

// Full-viewport quad from gl_VertexID, so no vertex buffer is needed.
const VERTEX_SHADER = `#version 300 es
const vec2 CORNERS[4] = vec2[4](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0)
);
void main() {
  gl_Position = vec4(CORNERS[gl_VertexID], 0.0, 1.0);
}
`

// Mirrors mosaicPixel() in radarMosaic.ts. Keep the two in step.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler2D;

const int MAX_STATIONS = ${MOSAIC_MAX_STATIONS};

uniform sampler2DArray u_frames;   // R8 palette indices, one layer per frame
uniform sampler2D u_lut;           // 256x1 RGBA, texel k = colour of index k
uniform vec2 u_size;               // canvas size, device px
uniform float u_alpha;             // layer opacity
uniform int u_count;               // stations in use
uniform vec4 u_disc[MAX_STATIONS]; // cx, cy (y down), radius, strength
uniform int u_layer[MAX_STATIONS]; // texture layer of each station's frame

out vec4 o_color;

// Palette index (0..255) of one texel of one layer.
float tap(ivec2 t, int layer) {
  return texelFetch(u_frames, ivec3(t, layer), 0).r * 255.0;
}

void main() {
  // gl_FragCoord is y-up; the station centres are y-down, like the page.
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  float bestScore = 0.0;
  int bestIndex = 0;
  float maxWeight = 0.0;

  for (int i = 0; i < MAX_STATIONS; i++) {
    if (i >= u_count) break;
    vec4 disc = u_disc[i];
    vec2 off = p - disc.xy;
    float d = length(off) / disc.z;
    if (d >= 1.0) continue;
    float w = disc.w; // hard circle: d < 1 is already checked above
    if (w <= 0.0) continue;

    // Position in the frame square, 0..1 on each side. Linear filtering
    // interpolates the index between source pixels; rounding below picks a
    // palette entry, so colours are never blended.
    vec2 uv = off / (2.0 * disc.z) + 0.5;
    int layer = u_layer[i];
    // The four nearest texels and the bilinear fractions.
    ivec2 edgeMax = ivec2(textureSize(u_frames, 0).xy) - 1;
    vec2 st = uv * vec2(edgeMax + 1) - 0.5;
    vec2 base = floor(st);
    vec2 f = st - base;
    ivec2 p0 = clamp(ivec2(base), ivec2(0), edgeMax);
    ivec2 p1 = clamp(ivec2(base) + 1, ivec2(0), edgeMax);
    vec4 taps = vec4(
      tap(p0, layer),
      tap(ivec2(p1.x, p0.y), layer),
      tap(ivec2(p0.x, p1.y), layer),
      tap(p1, layer)
    );
    vec4 bw = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    // Echo presence per tap (index 0 = no echo), and each tap's weight among echo taps.
    vec4 ew = bw * step(vec4(0.5), taps);
    // Presence: bilinear average of the echo mask. Alpha is a narrow smoothstep
    // around 0.5 (ECHO_EDGE_BAND in radarMosaic.ts), so the edge is sharp.
    float presence = dot(ew, vec4(1.0));
    float edgeAlpha = smoothstep(0.5 - ${ECHO_EDGE_BAND.toFixed(4)}, 0.5 + ${ECHO_EDGE_BAND.toFixed(4)}, presence);
    if (edgeAlpha <= 0.0) continue;
    // Colour: the index averaged over the echo taps only, rounded to a palette entry.
    float echoIdx = dot(ew, taps) / presence;
    int v = int(floor(echoIdx + 0.5));
    if (v == 0) continue;

    float aS = edgeAlpha * w; // this station's alpha: presence x circle x strength
    maxWeight = max(maxWeight, aS);
    float score = float(v) * w;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = v;
    }
  }

  if (bestIndex == 0) {
    o_color = vec4(0.0);
    return;
  }
  vec3 rgb = texelFetch(u_lut, ivec2(bestIndex, 0), 0).rgb;
  float a = maxWeight * u_alpha;
  o_color = vec4(rgb * a, a); // premultiplied, as the canvas expects
}
`

const CONTEXT_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
}

// Failed frame URLs are remembered so a tainted frame does not cost a
// readback every paint. Cleared when the set grows past this.
const MAX_FAILED_URLS = 256

export class RadarMosaicGl {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private onContextChange: () => void
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private frames: WebGLTexture | null = null
  private lut: WebGLTexture | null = null
  private loc: {
    frames: WebGLUniformLocation | null
    lut: WebGLUniformLocation | null
    size: WebGLUniformLocation | null
    alpha: WebGLUniformLocation | null
    count: WebGLUniformLocation | null
    disc: WebGLUniformLocation | null
    layer: WebGLUniformLocation | null
  } | null = null
  private maxLayers = 0
  private layers = 0
  private edge = 0
  private slotUrl: string[] = []
  private palette: readonly string[] | null = null
  private indexer: ColourIndexer | null = null
  private scratch: { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D } | null = null
  private failed = new Set<string>()
  private disposed = false

  /** The context is lost right now; paint the fallback until it is restored. */
  private lost = false
  /** Permanently unusable (restore failed, or the shader would not link). */
  private dead = false

  private readonly onLostListener = (e: Event) => {
    e.preventDefault()
    this.lost = true
    this.onContextChange()
  }
  private readonly onRestoredListener = () => {
    this.lost = false
    if (!this.init()) this.dead = true
    this.onContextChange()
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, onContextChange: () => void) {
    this.canvas = canvas
    this.gl = gl
    this.onContextChange = onContextChange
  }

  /**
   * A mosaic on `canvas`, or null when WebGL2 is unavailable or the shader
   * does not compile. Taking the WebGL context makes this canvas unusable for
   * 2D, so the caller must keep the 2D fallback on another canvas.
   */
  static create(canvas: HTMLCanvasElement, onContextChange: () => void): RadarMosaicGl | null {
    const gl = canvas.getContext('webgl2', CONTEXT_OPTIONS) as WebGL2RenderingContext | null
    if (!gl) return null
    const m = new RadarMosaicGl(canvas, gl, onContextChange)
    if (!m.init()) return null
    canvas.addEventListener('webglcontextlost', m.onLostListener)
    canvas.addEventListener('webglcontextrestored', m.onRestoredListener)
    return m
  }

  /** True when draw() can be attempted right now. */
  get usable(): boolean {
    return !this.disposed && !this.lost && !this.dead
  }

  /**
   * Compose the discs into the canvas. Returns false when nothing was drawn
   * (context lost, a frame could not be read, or GL failed), and the caller
   * must then paint the Canvas2D fallback.
   */
  draw(discs: readonly MosaicDisc[], palette: readonly string[], edge: number): boolean {
    if (!this.usable) return false
    const gl = this.gl
    const w = this.canvas.width
    const h = this.canvas.height
    if (!(w > 0 && h > 0) || !(edge > 0)) return false

    const usable: MosaicDisc[] = []
    const urls = new Set<string>()
    for (const d of discs) {
      if (!(d.radius > 0)) continue
      if (this.failed.has(d.url)) return false
      if (urls.has(d.url)) {
        // Same frame drawn twice (two stations sharing a URL): one layer, two discs.
        usable.push(d)
        continue
      }
      if (urls.size >= this.maxLayers) break
      urls.add(d.url)
      usable.push(d)
    }

    let current: string | null = null
    try {
      if (palette !== this.palette) this.setPalette(palette)
      if (edge !== this.edge || urls.size > this.layers) this.allocate(edge, urls.size)
      for (const url of urls) {
        if (this.slotUrl.includes(url)) continue
        current = url
        const d = usable.find(x => x.url === url)!
        const indices = this.indicesOf(d.bitmap, edge)
        this.uploadLayer(this.freeSlot(urls), url, indices)
      }
      current = null
    } catch {
      // A tainted frame (getImageData throws SecurityError) or a GL failure.
      // Remember the frame so later paints skip straight to 2D while it stays
      // in view; allocation failures are retried on the next paint.
      if (current) {
        this.failed.add(current)
        if (this.failed.size > MAX_FAILED_URLS) this.failed.clear()
      }
      return false
    }

    const disc = new Float32Array(MOSAIC_MAX_STATIONS * 4)
    const layer = new Int32Array(MOSAIC_MAX_STATIONS)
    let count = 0
    for (const d of usable) {
      if (count >= MOSAIC_MAX_STATIONS) break
      const slot = this.slotUrl.indexOf(d.url)
      if (slot < 0) continue
      disc.set([d.cx, d.cy, d.radius, d.strength], count * 4)
      layer[count] = slot
      count++
    }

    const loc = this.loc!
    gl.viewport(0, 0, w, h)
    gl.disable(gl.BLEND)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.frames)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.lut)
    gl.uniform1i(loc.frames, 0)
    gl.uniform1i(loc.lut, 1)
    gl.uniform2f(loc.size, w, h)
    gl.uniform1f(loc.alpha, MOSAIC_ALPHA)
    gl.uniform1i(loc.count, count)
    gl.uniform4fv(loc.disc, disc)
    gl.uniform1iv(loc.layer, layer)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.onLostListener)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestoredListener)
    const gl = this.gl
    if (!gl.isContextLost()) {
      if (this.frames) gl.deleteTexture(this.frames)
      if (this.lut) gl.deleteTexture(this.lut)
      if (this.program) gl.deleteProgram(this.program)
      if (this.vao) gl.deleteVertexArray(this.vao)
    }
    this.frames = this.lut = this.program = this.vao = null
    this.scratch = null
  }

  /** Build the program, the lookup texture and the VAO. Used on create and on context restore. */
  private init(): boolean {
    const gl = this.gl
    this.frames = this.lut = this.program = this.vao = null
    this.loc = null
    this.layers = 0
    this.edge = 0
    this.slotUrl = []
    this.palette = null
    this.indexer = null
    this.failed.clear()

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fs = vs ? compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER) : null
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs)
      return false
    }
    const program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('radar mosaic: program failed to link, using Canvas2D', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return false
    }
    this.program = program
    this.loc = {
      frames: gl.getUniformLocation(program, 'u_frames'),
      lut: gl.getUniformLocation(program, 'u_lut'),
      size: gl.getUniformLocation(program, 'u_size'),
      alpha: gl.getUniformLocation(program, 'u_alpha'),
      count: gl.getUniformLocation(program, 'u_count'),
      disc: gl.getUniformLocation(program, 'u_disc'),
      layer: gl.getUniformLocation(program, 'u_layer'),
    }
    this.vao = gl.createVertexArray()

    this.lut = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.lut)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number
    this.maxLayers = Math.max(0, Math.min(maxArrayLayers, MOSAIC_MAX_STATIONS))
    return this.maxLayers > 0
  }

  private setPalette(palette: readonly string[]): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.lut)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildPaletteLut(palette))
    this.palette = palette
    this.indexer = createColourIndexer(palette)
    // Indices depend on the palette, so every layer is stale.
    this.slotUrl = this.slotUrl.map(() => '')
  }

  /**
   * (Re)allocate the layer array at `edge`, with room for at least `needed`
   * layers. texStorage3D is immutable, so this makes a new texture; every
   * layer is re-uploaded afterwards.
   */
  private allocate(edge: number, needed: number): void {
    const gl = this.gl
    const depth = Math.max(1, Math.min(this.maxLayers, Math.max(needed, this.layers)))
    if (this.frames) gl.deleteTexture(this.frames)
    this.frames = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.frames)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, edge, edge, depth)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('radar mosaic: texture allocation failed')
    this.edge = edge
    this.layers = depth
    this.slotUrl = new Array<string>(depth).fill('')
  }

  /** A layer for `url` that no other frame in `needed` is using. */
  private freeSlot(needed: Set<string>): number {
    let i = this.slotUrl.indexOf('')
    if (i >= 0) return i
    i = this.slotUrl.findIndex(u => !needed.has(u))
    if (i < 0) throw new Error('radar mosaic: no free layer')
    return i
  }

  private uploadLayer(slot: number, url: string, indices: Uint8Array): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.frames)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, this.edge, this.edge, 1, gl.RED, gl.UNSIGNED_BYTE, indices)
    this.slotUrl[slot] = url
  }

  /**
   * The frame at `edge` x `edge` as palette indices. Reads pixels back, so it
   * throws on a tainted source.
   */
  private indicesOf(source: CanvasImageSource, edge: number): Uint8Array {
    if (!this.indexer) throw new Error('radar mosaic: no palette')
    if (!this.scratch) {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('radar mosaic: 2d context unavailable')
      this.scratch = { canvas, ctx }
    }
    const { canvas, ctx } = this.scratch
    try {
      if (canvas.width !== edge) canvas.width = edge
      if (canvas.height !== edge) canvas.height = edge
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.clearRect(0, 0, edge, edge)
      ctx.drawImage(source, 0, 0, edge, edge)
      const data = ctx.getImageData(0, 0, edge, edge).data
      return paletteIndicesFromRgba(data, this.indexer)
    } catch (err) {
      // A tainted draw taints this canvas for good; start from a fresh one next time.
      this.scratch = null
      throw err
    }
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('radar mosaic: shader failed to compile, using Canvas2D', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}
