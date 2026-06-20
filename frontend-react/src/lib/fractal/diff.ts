/** Pure prev→next node-id diff driving birth/extinction transitions. */
export interface NodeDiff {
  born: Set<string>;       // in next, not in prev
  extinct: Set<string>;    // in prev, not in next
  surviving: Set<string>;  // in both
  changed: boolean;        // any birth or extinction
}

export function diffNodes(prevIds: Iterable<string>, nextIds: Iterable<string>): NodeDiff {
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  const born = new Set<string>();
  const extinct = new Set<string>();
  const surviving = new Set<string>();
  for (const id of next) (prev.has(id) ? surviving : born).add(id);
  for (const id of prev) if (!next.has(id)) extinct.add(id);
  return { born, extinct, surviving, changed: born.size > 0 || extinct.size > 0 };
}
