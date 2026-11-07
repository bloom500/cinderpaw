/**
 * set_appearance — "make it dark", "bigger text", said in the chat.
 *
 * The person asks in words and the app changes; the tool only checks the
 * values and hands them back in `data`, and the desktop applies them when it
 * sees the result on the stream (cinderpawAgentStream.ts), the same way the
 * heads-up card rides `heads_up`'s data. Hermes ships the same (`set_theme`,
 * 1 Nov). Outside the desktop nothing listens, and the result says so.
 */

import type { Tool } from "../../types.ts";

const THEMES = ["light", "dark", "system"] as const;
const SIZES = ["small", "default", "large", "larger"] as const;

export function createSetAppearanceTool(): Tool {
  return {
    manifest: {
      name: "set_appearance",
      description:
        "Change how the Cinderpaw desktop app looks when the person asks: `theme` light, dark or system " +
        "(follows the computer), and/or `chatTextSize` small, default, large or larger. Applies at once.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      theme: { type: "string", description: "light | dark | system", required: false },
      chatTextSize: { type: "string", description: "small | default | large | larger", required: false },
    },
    async execute(args) {
      const theme = typeof args.theme === "string" ? args.theme.trim().toLowerCase() : undefined;
      const chatTextSize = typeof args.chatTextSize === "string" ? args.chatTextSize.trim().toLowerCase() : undefined;
      if (!theme && !chatTextSize) {
        return { ok: false, error: "bad_args", content: "set_appearance: give `theme` (light, dark, system) or `chatTextSize` (small, default, large, larger)." };
      }
      if (theme && !(THEMES as readonly string[]).includes(theme)) {
        return { ok: false, error: "bad_args", content: `set_appearance: theme must be one of ${THEMES.join(", ")}.` };
      }
      if (chatTextSize && !(SIZES as readonly string[]).includes(chatTextSize)) {
        return { ok: false, error: "bad_args", content: `set_appearance: chatTextSize must be one of ${SIZES.join(", ")}.` };
      }
      const said = [theme && `theme ${theme}`, chatTextSize && `chat text ${chatTextSize}`].filter(Boolean).join(" and ");
      return {
        ok: true,
        content: `Set ${said} in the desktop app. If the person is not in the desktop app, tell them it changes there, under Settings > Appearance.`,
        data: { appearance: { ...(theme ? { theme } : {}), ...(chatTextSize ? { chatTextSize } : {}) } },
      };
    },
  };
}
