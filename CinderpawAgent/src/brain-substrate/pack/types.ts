/**
 * CinderBrain pack: the on-disk shape of a connectome the simulator can run.
 *
 * A pack is a directory: `manifest.json`, `csr.bin` (the graph), `plastic.bin`
 * (which edges may learn) and `ATTRIBUTION.md`. Spec: docs/superpowers/specs/
 * 2026-09-14-cinderbrain-design.md section 2.1.
 */

export type Role =
  | "sensory"
  | "kc"
  | "mbon"
  | "dan"
  | "persistent-state"
  | "neuromodulator"
  | "sensory-visual";

export const ROLES: readonly Role[] = [
  "sensory",
  "kc",
  "mbon",
  "dan",
  "persistent-state",
  "neuromodulator",
  "sensory-visual",
];

export interface SimParams {
  vRest: number;
  vThresh: number;
  tauM: number;
  tauS: number;
  refractoryMs: number;
  delayMs: number;
  wSyn: number;
  dtMs: number;
}

/** Shiu et al. 2024 leaky integrate-and-fire parameters (mV, ms). */
export const SHIU_2024: SimParams = {
  vRest: -52,
  vThresh: -45,
  tauM: 20,
  tauS: 5,
  refractoryMs: 2.2,
  delayMs: 1.8,
  wSyn: 0.275,
  dtMs: 0.1,
};

export interface Compartment {
  id: string;
  mbonValence: "approach" | "avoidance";
  danIds: number[];
}

export interface Manifest {
  packId: string;
  species: string;
  source: { name: string; doi: string; release: string };
  completeness: "whole-brain" | "region";
  packFormatVersion: 1;
  simulatorAbiVersion: 1;
  license: string;
  attributionFile: string;
  neurons: number;
  edges: number;
  plasticEdges: number;
  simParams: SimParams;
  seed: number;
  populations: Partial<Record<Role, number[]>>;
  compartments: Compartment[];
  plasticity: { rule: "kc-mbon-depression-v1"; eta: number; maxDelta: number | null };
  sha256: { "csr.bin": string; "plastic.bin": string };
}

export interface PlasticEdges {
  /** Positions into colIdx/weight that are KC to MBON. */
  edgeIdx: Int32Array;
  /** The KC (source neuron) of each plastic edge. */
  src: Int32Array;
  /** Index into manifest.compartments. */
  compartment: Int8Array;
}

export interface BrainPack {
  manifest: Manifest;
  dir: string;
  csrSha256: string;
  rowPtr: Int32Array;
  colIdx: Int32Array;
  /** Signed effective structural weight: sign * synCount * wSyn. */
  weight: Float32Array;
  plastic: PlasticEdges;
  populations: Partial<Record<Role, Int32Array>>;
}

export interface PackFiles {
  manifest: Omit<Manifest, "sha256">;
  rowPtr: Int32Array;
  colIdx: Int32Array;
  weight: Float32Array;
  plastic: PlasticEdges;
}

/** One plain sentence; these messages go on screen. */
export class PackError extends Error {
  override name = "PackError";
}

export const CSR_MAGIC = "CBRC";
export const PLASTIC_MAGIC = "CBRP";
export const HEADER_BYTES = 16;
