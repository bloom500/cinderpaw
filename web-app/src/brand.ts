/// <reference types="vite/client" />
// The Desktop app's own mascot and logo, imported rather than copied, so the
// browser app can never drift from them. Both are self-contained: the mascot
// needs only React (deduplicated in vite.config.ts) and its own CSS.
export { CinderpawMascot } from "../../frontend-react/src/components/chat/mascot/CinderpawMascot";
export type { MascotState } from "../../frontend-react/src/components/chat/mascot/frames";
export { default as logoUrl } from "../../frontend-react/src/assets/logo.svg";
