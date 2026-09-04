/** B2 fixture — sleeps far past any test timeout (AC3: killed + reported). */
export default {
  async retrieve(): Promise<{ items: never[] }> {
    await new Promise((r) => setTimeout(r, 60_000));
    return { items: [] };
  },
};
