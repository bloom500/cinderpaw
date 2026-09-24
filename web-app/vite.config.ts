import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Fixed file names: the CLI's build.rs embeds exactly these three files.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: { entryFileNames: "app.js", chunkFileNames: "app.js", assetFileNames: "app[extname]", inlineDynamicImports: true },
    },
  },
});
