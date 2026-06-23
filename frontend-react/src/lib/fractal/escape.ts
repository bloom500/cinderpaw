/**
 * CPU mirror of the shader's smooth-iteration Mandelbrot math, used by the
 * FilamentText layer to orient memory labels along the fractal's filaments.
 * Kept independent of WebGL so it is pure and unit-testable.
 */

const BAIL = 256.0;

/** Smooth (normalized) iteration count at complex point (cx,cy). Returns
 *  exactly `maxIter` when the point is interior (never escaped).
 *  `shear` skews c (cx += shear*cy) before iterating; a non-zero shear breaks
 *  the z^2+c real-axis mirror symmetry that otherwise reads as a doubled set. */
export function escapeTime(cx: number, cy: number, maxIter: number, shear = 0): number {
  cx += shear * cy;
  let zx = 0, zy = 0, i = 0;
  while (i < maxIter) {
    const nx = zx * zx - zy * zy + cx;
    const ny = 2 * zx * zy + cy;
    zx = nx; zy = ny;
    const mag2 = zx * zx + zy * zy;
    if (mag2 > BAIL) {
      // smooth: i + 1 - log2(log2|z|)
      const logZn = Math.log(mag2) / 2;
      const nu = Math.log(logZn / Math.LN2) / Math.LN2;
      return i + 1 - nu;
    }
    i++;
  }
  return maxIter;
}

/** Unit tangent of the escape-time level set at (cx,cy): perpendicular to the
 *  central-difference gradient. `eps` is the sampling step in complex units. */
export function filamentTangent(
  cx: number, cy: number, maxIter: number, eps: number,
): { tx: number; ty: number } {
  const gx = (escapeTime(cx + eps, cy, maxIter) - escapeTime(cx - eps, cy, maxIter)) / (2 * eps);
  const gy = (escapeTime(cx, cy + eps, maxIter) - escapeTime(cx, cy - eps, maxIter)) / (2 * eps);
  // tangent ⟂ gradient
  let tx = -gy, ty = gx;
  const len = Math.hypot(tx, ty) || 1;
  return { tx: tx / len, ty: ty / len };
}
