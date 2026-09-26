/**
 * A QR code as a picture. The half-block text drawn for terminals does not
 * scan on a page: the blocks come out wider than tall with gaps between the
 * lines (seen live 25 Sep, the phone would not read it). This draws each
 * module as a square, black on white, with the four-module white border
 * scanners expect.
 *
 * ponytail: qrcode-terminal's own encoder (Apache-2.0), already a dependency.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require("qrcode-terminal/vendor/QRCode") as new (type: number, level: number) => {
  addData(text: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const LEVEL = (require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { L: number }).L;

export function qrSvg(text: string): string {
  const q = new QRCode(-1, LEVEL);
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const size = n + 8;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}
