// Written for Cinderpaw in the lucide-animated style (same handle and hover
// API as the vendored icons here). Drawing: Lucide's "shapes" (ISC).
// Artifacts, 14 Nov: the three shapes Cubby made play one after another:
// the triangle hops, the square tips a quarter turn, the circle bounces.

import type { Variants } from "framer-motion";
import { motion, useAnimation } from "framer-motion";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface ShapesIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ShapesIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const TRIANGLE: Variants = {
  normal: { y: 0, transition: { duration: 0.3 } },
  animate: { y: [0, -3.5, 0.8, 0], transition: { duration: 0.55, ease: "easeOut" } },
};
const SQUARE: Variants = {
  normal: { rotate: 0, transition: { duration: 0.3 } },
  animate: { rotate: [0, 90], transition: { duration: 0.5, delay: 0.08, type: "spring", stiffness: 260, damping: 14 } },
};
const CIRCLE: Variants = {
  normal: { y: 0, scaleX: 1, scaleY: 1, transition: { duration: 0.3 } },
  animate: {
    y: [0, -3, 0, 0],
    scaleX: [1, 0.9, 1.15, 1],
    scaleY: [1, 1.1, 0.85, 1],
    transition: { duration: 0.6, delay: 0.16, ease: "easeOut" },
  },
};

const ShapesIcon = forwardRef<ShapesIconHandle, ShapesIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;
      return {
        startAnimation: () => controls.start("animate"),
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) onMouseEnter?.(e);
        else controls.start("animate");
      },
      [controls, onMouseEnter]
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) onMouseLeave?.(e);
        else controls.start("normal");
      },
      [controls, onMouseLeave]
    );

    return (
      <div className={cn(className)} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...props}>
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <motion.path
            animate={controls}
            d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"
            initial="normal"
            variants={TRIANGLE}
          />
          <motion.rect
            animate={controls}
            height="7"
            initial="normal"
            rx="1"
            style={{ originX: 0.5, originY: 0.5 }}
            variants={SQUARE}
            width="7"
            x="3"
            y="14"
          />
          <motion.circle
            animate={controls}
            cx="17.5"
            cy="17.5"
            initial="normal"
            r="3.5"
            style={{ originX: 0.5, originY: 1 }}
            variants={CIRCLE}
          />
        </svg>
      </div>
    );
  }
);

ShapesIcon.displayName = "ShapesIcon";

export { ShapesIcon };
