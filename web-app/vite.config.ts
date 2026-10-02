import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Fixed file names: the CLI's build.rs embeds exactly these three files, so
// every font and picture is inlined into them (assetsInlineLimit) rather than
// emitted beside them, where nothing would serve it.
export default defineConfig({
  plugins: [react()],
  // The mascot is the Desktop app's own component (frontend-react); its file
  // must use this app's React, not a second copy from that folder.
  resolve: { dedupe: ["react", "react-dom"] },
  server: { fs: { allow: [".", "../frontend-react/src/components/chat/mascot", "../frontend-react/src/assets/logo.svg"] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: () => true,
    rollupOptions: {
      output: { entryFileNames: "app.js", chunkFileNames: "app.js", assetFileNames: "app[extname]", inlineDynamicImports: true },
    },
  },
});
