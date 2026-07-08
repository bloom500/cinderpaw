/** B2 fixture — a pure retrieval module. Math.random proves the host's
 *  seeded-RNG shim: same seed → same score across host restarts. */
export default {
  async retrieve(req: { query: string; k: number; sessionId: string }): Promise<{
    items: Array<{ text: string; score: number; sourceId: string }>;
  }> {
    return {
      items: [{ text: `echo:${req.query}`, score: Math.random(), sourceId: "fixture" }],
    };
  },
};
