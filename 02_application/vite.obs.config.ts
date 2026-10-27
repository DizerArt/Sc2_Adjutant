import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// OBS ships only its page/assets, independently of the desktop UI and voice WASM.
export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  build: {
    outDir: "dist-obs",
    emptyOutDir: true,
    rollupOptions: { input: { obs: resolve(__dirname,"obs.html"), postmatch: resolve(__dirname,"postmatch.html") } }
  }
});
