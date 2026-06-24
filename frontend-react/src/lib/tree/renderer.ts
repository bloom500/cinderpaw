import type { TreeBuffers } from './geometry';

export interface TreeView { aspect: number }
export interface TreeRenderer {
  draw(buffers: TreeBuffers, view: TreeView): void;
  resize(): void;
  dispose(): void;
}

const BG: [number, number, number] = [0.039, 0.039, 0.043]; // #0a0a0b

const BRANCH_VS = `#version 300 es
in vec2 a_pos;
in float a_shade;
uniform float u_aspect;
out float v_shade;
void main() {
  v_shade = a_shade;
  // tree-space [0,1] (y up) → clip space, x corrected for aspect.
  vec2 p = a_pos * 2.0 - 1.0;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BRANCH_FS = `#version 300 es
precision highp float;
in float v_shade;
out vec4 outColor;
void main() {
  vec3 darkBark = vec3(0.141, 0.102, 0.071);  // #241a12
  vec3 warmRim  = vec3(0.353, 0.227, 0.118);  // #5a3a1e
  outColor = vec4(mix(darkBark, warmRim, v_shade), 1.0);
}`;

const LEAF_VS = `#version 300 es
in vec2 a_corner;      // unit quad corner (-0.5..0.5)
in vec4 a_inst;        // x, y, size, angle
uniform float u_aspect;
out vec2 v_uv;
void main() {
  v_uv = a_corner + 0.5;
  float s = sin(a_inst.w), c = cos(a_inst.w);
  vec2 r = vec2(a_corner.x * c - a_corner.y * s, a_corner.x * s + a_corner.y * c);
  vec2 pos = a_inst.xy + r * a_inst.z;
  vec2 p = pos * 2.0 - 1.0;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const LEAF_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
void main() {
  // Round leaf mask via distance from center; alpha-test the rim.
  float d = distance(v_uv, vec2(0.5));
  if (d > 0.5) discard;
  vec3 amber  = vec3(0.851, 0.541, 0.169);  // #d98a2b
  vec3 orange = vec3(0.910, 0.329, 0.118);  // #e8541e
  vec3 col = mix(amber, orange, v_uv.y);
  float edge = smoothstep(0.5, 0.35, d);
  outColor = vec4(col, edge);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('tree shader compile failed:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('tree program link failed:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

export function createTreeRenderer(canvas: HTMLCanvasElement): TreeRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) return null;

  const branchProg = link(gl, BRANCH_VS, BRANCH_FS);
  const leafProg = link(gl, LEAF_VS, LEAF_FS);
  if (!branchProg || !leafProg) return null;

  // Branch buffers.
  const branchVAO = gl.createVertexArray();
  gl.bindVertexArray(branchVAO);
  const posBuf = gl.createBuffer();
  const shadeBuf = gl.createBuffer();
  const aPos = gl.getAttribLocation(branchProg, 'a_pos');
  const aShade = gl.getAttribLocation(branchProg, 'a_shade');
  const uBranchAspect = gl.getUniformLocation(branchProg, 'u_aspect');

  // Leaf buffers (unit quad + instanced attributes).
  const leafVAO = gl.createVertexArray();
  gl.bindVertexArray(leafVAO);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(leafProg, 'a_corner');
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
  const instBuf = gl.createBuffer();
  const aInst = gl.getAttribLocation(leafProg, 'a_inst');
  const uLeafAspect = gl.getUniformLocation(leafProg, 'u_aspect');

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const draw = (buffers: TreeBuffers, view: TreeView) => {
    resize();
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Branches (opaque).
    gl.useProgram(branchProg);
    gl.bindVertexArray(branchVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.branchPositions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, shadeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.branchShade, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aShade);
    gl.vertexAttribPointer(aShade, 1, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uBranchAspect, view.aspect);
    gl.drawArrays(gl.TRIANGLES, 0, buffers.branchVertexCount);

    // Leaves (alpha-blended, instanced).
    gl.useProgram(leafProg);
    gl.bindVertexArray(leafVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.leafInstances, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aInst);
    gl.vertexAttribPointer(aInst, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aInst, 1);
    gl.uniform1f(uLeafAspect, view.aspect);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, buffers.leafInstanceCount);
    gl.disable(gl.BLEND);
  };

  const dispose = () => {
    gl.deleteProgram(branchProg);
    gl.deleteProgram(leafProg);
    gl.deleteBuffer(posBuf); gl.deleteBuffer(shadeBuf);
    gl.deleteBuffer(quadBuf); gl.deleteBuffer(instBuf);
    gl.deleteVertexArray(branchVAO); gl.deleteVertexArray(leafVAO);
  };

  return { draw, resize, dispose };
}
