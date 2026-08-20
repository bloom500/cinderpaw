/**
 * The curl at the bottom corner of a message bubble — the iMessage signature.
 *
 * Drawn as SVG rather than with the usual two-pseudo-element CSS trick. That
 * trick works by painting a second shape in the PAGE's colour to mask the
 * corner, which needs the page to be one flat colour. Ours is a moving
 * gradient with grain over it, so the mask would show up as a small solid
 * rectangle sliding across the scene. A filled path has nothing to hide.
 *
 * Sized to sit flush against a 10px corner radius: the flat top edge overlaps
 * the bubble by a pixel so no seam shows between the two fills.
 */
export function BubbleTail({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="18"
      viewBox="0 0 14 18"
      aria-hidden
      focusable="false"
      className={className}
    >
      {/* Two curves and a straight edge. Convex out to the tip, concave back
          underneath, and a flat left side that sits flush on the bubble —
          whose bottom-right corner is square precisely so these two fills
          meet without a seam. Invented geometry produced a notch on the first
          try and a shape with no curl on the second; this is the shape the
          thing actually is. */}
      <path
        d="M0 1 C0 10 3.5 16 14 18 C7.5 18 2.5 16.5 0 11.5 Z"
        fill="currentColor"
      />
    </svg>
  );
}
