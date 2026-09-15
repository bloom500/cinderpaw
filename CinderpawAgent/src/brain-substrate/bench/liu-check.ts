/**
 * Variant 1, step G3 (VALIDATION-LADDER.md, 2026-09-15 21:00): the Liu et al. 2021 rate
 * model checked against its own analytic results and the claims in its figure captions.
 *
 * bun run src/brain-substrate/bench/liu-check.ts --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIU_DL5, LIU_FIG45, LIU_VM7, liuAdapted, liuInitial, liuSteadyState, liuStep, type LiuParams } from "../al-rate/liu2021.ts";

const run = (pr: LiuParams, input: (t: number) => number, pub: number, T: number, dt: number, onStep?: (t: number, rPN: number) => void) => {
  let s = liuInitial();
  const n = Math.round(T / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt, r = input(t);
    s = liuStep(s, pr, r, r + pub, dt);
    onStep?.(t + dt, s.rPN);
  }
  return s;
};

const out = resolve(process.argv[process.argv.indexOf("--out") + 1] ?? "bench-results/brain/variant1/g3");
mkdirSync(out, { recursive: true });
const md: string[] = ["# CinderBrain Variant 1 step G3: Liu et al. 2021 reference model", ""];

// G3a
let worst = 0;
const rowsA: string[] = [];
for (const [name, pr] of [["DL5", LIU_DL5], ["VM7", LIU_VM7]] as const) {
  for (const pub of [0, 100, 500]) for (const r of [5, 10, 20, 50, 100, 200]) {
    const want = liuSteadyState(pr, r, r + pub);
    const got1 = run(pr, () => r, pub, 10, 5e-5).rPN, got2 = run(pr, () => r, pub, 10, 1e-4).rPN;
    const e1 = Math.abs(got1 - want) / want, e2 = Math.abs(got2 - want) / want;
    worst = Math.max(worst, e1, e2);
    rowsA.push(`| ${name} | ${pub} | ${r} | ${want.toFixed(2)} | ${got1.toFixed(2)} | ${(100 * e1).toFixed(3)}% | ${(100 * e2).toFixed(3)}% |`);
  }
}
const passA = worst <= 0.01;
md.push(`## G3a steady state vs Equation 12: ${passA ? "PASS" : "FAIL"} (worst error ${(100 * worst).toFixed(3)}%)`, "",
  "| glomerulus | public Hz | private Hz | Eq 12 Hz | simulated (dt 0.05 ms) | error | error (dt 0.1 ms) |", "|---|---|---|---|---|---|---|", ...rowsA, "");

// G3b ramp
const dt = 5e-5, Ks = [50, 100, 200, 400];
const at3 = Ks.map((K) => run(LIU_FIG45, (t) => K * t, 0, 3, dt).rPN);
const adapted = liuAdapted(LIU_FIG45);
const spread = (Math.max(...at3) - Math.min(...at3)) / Math.min(...at3);
const vsEq15 = Math.max(...at3.map((v) => Math.abs(v - adapted) / adapted));
const passRamp = spread <= 0.1 && vsEq15 <= 0.1;
md.push(`## G3b ramp R = K t: ${passRamp ? "PASS" : "FAIL"}`, "",
  `R_PN at t = 3 s for K = ${Ks.join(", ")} Hz/s: ${at3.map((v) => v.toFixed(2)).join(", ")} Hz; spread ${(100 * spread).toFixed(1)}%; Equation 15 adapted ${adapted.toFixed(2)} Hz, worst deviation ${(100 * vsEq15).toFixed(1)}%.`, "");

// G3b triangle
const PEAK = 200;
const tri = Ks.map((K) => {
  const tPeak = PEAK / K;
  let best = 0, bestT = 0;
  run(LIU_FIG45, (t) => (t <= tPeak ? K * t : Math.max(0, PEAK - K * (t - tPeak))), 0, 2 * tPeak + 1, dt, (t, v) => { if (v > best) { best = v; bestT = t; } });
  return { K, tPeak, best, bestT };
});
const monotone = tri.every((x, i) => i === 0 || x.best > tri[i - 1]!.best);
const early = tri.every((x) => x.bestT < x.tPeak);
const passTri = monotone && early;
md.push(`## G3b triangle (peak ORN ${PEAK} Hz): ${passTri ? "PASS" : "FAIL"}`, "",
  "| K Hz/s | input peak s | PN peak Hz | PN peak time s |", "|---|---|---|---|",
  ...tri.map((x) => `| ${x.K} | ${x.tPeak.toFixed(3)} | ${x.best.toFixed(2)} | ${x.bestT.toFixed(3)} |`),
  "", `peak increases with K: ${monotone}; PN peaks before input for every K: ${early}`, "");

// G3c
const hill = (pr: LiuParams) => {
  const avg = (r: number) => { let sum = 0, n = 0; run(pr, () => r, 0, 0.5, dt, (_, v) => { sum += v; n++; }); return sum / n; };
  const rs = [1, 2, 5, 10, 20, 50, 100, 200, 400], ys = rs.map(avg), max = Math.max(...ys);
  const i = ys.findIndex((y) => y >= max / 2);
  if (i <= 0) return NaN;
  return (Math.log(ys[i]!) - Math.log(ys[i - 1]!)) / (Math.log(rs[i]!) - Math.log(rs[i - 1]!));
};
md.push(`## G3c (reported, not gated): local log-log slope of the 500 ms average PN response near half-max, public 0`, "",
  `DL5 ${hill(LIU_DL5).toFixed(2)}; VM7 ${hill(LIU_VM7).toFixed(2)} (paper: gamma_a ~ 1.5 from the Olsen 2010 fit; this slope is a coarse estimate between grid points).`, "",
  `VERDICT G3: ${passA && passRamp && passTri ? "PASS, the implementation and unit convention reproduce the paper's analytic results and stated behaviour" : "FAIL, fix the implementation or unit convention, never a parameter"}`, "");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(out, `${stamp}-g3-liu.md`), md.join("\n"));
console.log(md.join("\n"));
