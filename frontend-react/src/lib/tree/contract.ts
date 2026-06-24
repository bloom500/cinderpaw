/** The reactive data contract — memory clusters + RSI maturity. This is
 *  the surviving signal from the old fractal `OrganismInput`; only its
 *  interpretation changes (fractal params → tree params). */
export interface TreeInput {
  /** Distinct memory clusters (node-type diversity proxy). */
  clusterCount: number;
  /** Surviving ("elite") node count — the reactive foliage volume. */
  eliteNodeCount: number;
  /** RSI maturity signal; null before the engine has run. */
  rsi: { iteration: number; boundsVersion: number } | null;
  /** Persisted monotonic maturity floor. */
  persistedFloor: number;
  /** Cluster positions (for limb bias); may be empty. */
  clusters: { x: number; y: number; weight: number }[];
}
