/**
 * The ONE way an ARC cell colour is written, anywhere the model can see it.
 *
 * WHY THIS FILE EXISTS, in the model's own words. A press cost 65,536
 * completion tokens — the output ceiling, hit and truncated — and most of that
 * monologue was the model trying to reconcile two things WE told it:
 *
 *     "color 10 is 'a' in hex? Colors listed: 10x1805, 3x178, 14x147 ...
 *      But colors list uses decimal? Wait colors list says 10x1805"
 *
 * It was right to be confused. `renderGrid` writes each cell as one hex digit,
 * so colour 10 appears in the grid as `a`. The scene description and the click
 * candidates wrote the same colour as `10`. Two encodings for one thing, in one
 * prompt, with nothing saying they were the same — so the model spent a fortune
 * building the mapping we could have handed it for free, and then ran out of
 * tokens before answering.
 *
 * So there is one function. Everything the model reads goes through it: the
 * grid, the scene summary, the candidate list. A second representation cannot
 * appear unless somebody adds one deliberately, and a test walks all sixteen
 * colours through every renderer to make sure nobody has.
 */

/**
 * A colour as the model will see it: one hex digit, because that is what the
 * grid is made of and the grid is the ground truth.
 *
 * ARC sends 0-15. Anything else is not a colour we know how to draw, and `?` is
 * the honest rendering — the same character `renderGrid` has always used for an
 * out-of-range cell, so an oddity looks identical wherever it shows up.
 */
export function colourChar(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 15
    ? value.toString(16)
    : "?";
}
