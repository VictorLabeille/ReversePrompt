// Rendu WebGL2 de la forme liquide : compile les shaders une fois, puis dessine un triangle
// plein écran par image avec les paramètres de forme courants.

import { fragmentSource, vertexSource } from './shader';

export type Rgba = [number, number, number, number];

export interface BlobShape {
  headX: number;
  headY: number;
  headHalfW: number;
  headHalfH: number;
  threadTipR: number;
  threadTopR: number;
  threadTipY: number;
  lipHalfW: number;
  lipH: number;
}

export interface BlobStyle {
  edgeOffset: number;
  edgeSmooth: number;
  headSmooth: number;
  fill: Rgba;
  shadow: Rgba;
  shadowBlur: number;
  shadowOffsetY: number;
}

const UNIFORMS = ['uSize', 'uDpr', 'uHead', 'uThread', 'uLip', 'uSmooth', 'uFill', 'uShadow', 'uShadowGeo'] as const;
type UniformName = (typeof UNIFORMS)[number];

export class BlobRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Édition de liens du shader : ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    gl.clearColor(0, 0, 0, 0);

    this.uniforms = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(program, n)])) as Record<
      UniformName,
      WebGLUniformLocation | null
    >;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render(shape: BlobShape, style: BlobStyle): void {
    const { gl, uniforms: u } = this;
    gl.uniform2f(u.uSize, this.width, this.height);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform4f(u.uHead, shape.headX, shape.headY, shape.headHalfW, shape.headHalfH);
    gl.uniform3f(u.uThread, shape.threadTipR, shape.threadTopR, shape.threadTipY);
    gl.uniform2f(u.uLip, shape.lipHalfW, shape.lipH);
    gl.uniform3f(u.uSmooth, style.edgeOffset, style.edgeSmooth, style.headSmooth);
    gl.uniform4f(u.uFill, ...style.fill);
    gl.uniform4f(u.uShadow, ...style.shadow);
    gl.uniform2f(u.uShadowGeo, style.shadowBlur, style.shadowOffsetY);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  clear(): void {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Création du shader impossible');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Compilation du shader : ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}
