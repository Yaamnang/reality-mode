// Draws pictures stretched with perspective. A 2D canvas can only stretch evenly, so this uses a
// small WebGL canvas, which the caller then draws onto its own canvas.

export interface WarpLayer {
  source: HTMLCanvasElement; // must not change after its first use: it's kept on the GPU
  matrix: number[]; // 9 numbers, row by row: picture -> screen, both 0..1
  alpha: number;
  gain: number; // brightness
}

const VERTEX = `
attribute vec2 corner;
varying vec2 screen;
void main() {
  screen = vec2((corner.x + 1.0) / 2.0, (1.0 - corner.y) / 2.0);
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 screen;
uniform mat3 toPicture;
uniform sampler2D picture;
uniform float alpha;
uniform float gain;
void main() {
  vec3 p = toPicture * vec3(screen, 1.0);
  vec2 uv = p.xy / p.z;
  if (p.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  vec4 c = texture2D(picture, uv);
  gl_FragColor = vec4(min(c.rgb * gain, vec3(c.a)), c.a) * alpha;
}`;

let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let failed = false;
let toPicture: WebGLUniformLocation | null = null;
let alphaAt: WebGLUniformLocation | null = null;
let gainAt: WebGLUniformLocation | null = null;
const textures = new WeakMap<HTMLCanvasElement, WebGLTexture>();

function setUp(): boolean {
  if (gl) return !gl.isContextLost();
  if (failed) return false;
  canvas = document.createElement("canvas");
  gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
  const fail = () => {
    failed = true;
    gl = null;
    return false;
  };
  if (!gl) return fail();
  const compile = (type: number, text: string) => {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, text);
    gl!.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return fail();
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  toPicture = gl.getUniformLocation(program, "toPicture");
  alphaAt = gl.getUniformLocation(program, "alpha");
  gainAt = gl.getUniformLocation(program, "gain");
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  return true;
}

function textureOf(source: HTMLCanvasElement): WebGLTexture {
  const known = textures.get(source);
  if (known) return known;
  const g = gl!;
  const texture = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, texture);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, source);
  textures.set(source, texture);
  return texture;
}

function invert(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const det = a * A + d * B + g * C;
  return [A, B, C, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map((v) => v / det);
}

// Draws the layers, in order, onto a w x h picture and returns it. Use it right away, in the same
// frame. null if this device has no WebGL.
export function warpLayers(w: number, h: number, layers: WarpLayer[]): HTMLCanvasElement | null {
  if (!setUp()) return null;
  const g = gl!;
  if (canvas!.width !== w || canvas!.height !== h) {
    canvas!.width = w;
    canvas!.height = h;
    g.viewport(0, 0, w, h);
  }
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  for (const layer of layers) {
    g.bindTexture(g.TEXTURE_2D, textureOf(layer.source));
    const v = invert(layer.matrix);
    // WebGL lists matrices column by column.
    g.uniformMatrix3fv(toPicture, false, [v[0], v[3], v[6], v[1], v[4], v[7], v[2], v[5], v[8]]);
    g.uniform1f(alphaAt, layer.alpha);
    g.uniform1f(gainAt, layer.gain);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
  return canvas;
}
