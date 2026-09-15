/**
 * One glomerulus of the antennal lobe as a rate model: Liu, Li, Tang, Qin & Tu 2021,
 * "Short-Term Plasticity Regulates Both Divisive Normalization and Adaptive Responses in
 * Drosophila Olfactory System", Front Comput Neurosci 15:730431 (PMC8568954), Eqs 1-5.
 *
 * A cognate ORN at rate R drives its PN through a synapse with short-term facilitation (u)
 * and depression (x); a local-neuron pool driven by all ORNs applies presynaptic inhibition
 * (p) to that synapse.
 *
 * Units: seconds and Hz. The paper lists weights in nS and gives k = 5 Hz/nS once (its
 * Figure 5); weights enter as k * w. That convention is an inference, checked in step G3
 * against the paper's own steady state (Equation 12).
 */

export interface LiuParams {
  tauE: number; // s
  wEE: number; // nS
  wIE: number; // nS
  rho: number; // s
  U: number;
  tauD: number; // s
  tauF: number; // s
  tauP: number; // s
  k: number; // Hz/nS
}

/** Table 1 (Figure 2 fits). tau_p and k are not in the table; the only values the paper gives are used. */
export const LIU_DL5: LiuParams = { tauE: 0.05, wEE: 160, wIE: 10, rho: 0.0019, U: 0.31, tauD: 0.368, tauF: 0.339, tauP: 0.3, k: 5 };
export const LIU_VM7: LiuParams = { tauE: 0.05, wEE: 105, wIE: 10, rho: 0.0025, U: 0.24, tauD: 0.16, tauF: 0.15, tauP: 0.3, k: 5 };
/** Figures 4 and 5 (Kim et al. 2015 comparison); every parameter is given there. */
export const LIU_FIG45: LiuParams = { tauE: 0.055, wEE: 75, wIE: 21, rho: 0.008, U: 0.24, tauD: 0.1, tauF: 0.05, tauP: 0.3, k: 5 };

export interface LiuState { rPN: number; rLN: number; p: number; x: number; uMinus: number }

export const liuInitial = (): LiuState => ({ rPN: 0, rLN: 0, p: 1, x: 1, uMinus: 0 });

/** One forward-Euler step. `r` = cognate ORN rate, `rTotal` = sum over all ORNs the LN pool sees (includes r). */
export function liuStep(s: LiuState, pr: LiuParams, r: number, rTotal: number, dt: number): LiuState {
  const uPlus = s.uMinus + pr.U * (1 - s.uMinus);
  return {
    rPN: s.rPN + dt * (-s.rPN / pr.tauE + pr.k * pr.wEE * uPlus * s.x * s.p * r),
    rLN: s.rLN + dt * (-s.rLN / pr.tauE + pr.k * pr.wIE * rTotal),
    p: s.p + (dt / pr.tauP) * (-s.p + 1 / (1 + pr.rho * s.rLN)),
    x: s.x + dt * ((1 - s.x) / pr.tauD - s.x * uPlus * s.p * r),
    uMinus: s.uMinus + dt * (-s.uMinus / pr.tauF + pr.U * (1 - s.uMinus) * s.p * r),
  };
}

/** Equation 12: steady-state PN rate for constant cognate rate r and total ORN input rTotal. */
export function liuSteadyState(pr: LiuParams, r: number, rTotal: number): number {
  const A = pr.k * pr.rho * pr.wIE * pr.tauE;
  const theta = 1 + A * rTotal;
  return (pr.tauE * pr.k * pr.wEE * pr.U * r * (theta + pr.tauF * r)) /
    (theta * theta + theta * (pr.tauF + pr.tauD) * pr.U * r + pr.tauD * pr.tauF * pr.U * r * r);
}

/** Equation 15 with R_eff* = 1/A: the adapted PN rate under a ramp input. */
export function liuAdapted(pr: LiuParams): number {
  const rEff = 1 / (pr.k * pr.rho * pr.wIE * pr.tauE);
  return (pr.tauE * pr.k * pr.wEE * pr.U * rEff * (1 + pr.tauF * rEff)) /
    (1 + pr.U * rEff * (pr.tauF + pr.tauD) + pr.U * pr.tauD * pr.tauF * rEff * rEff);
}
