import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  root: ".",
  base: "./",
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
        obs: resolve(__dirname, "obs.html"),
        postmatch: resolve(__dirname, "postmatch.html")
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      // Tauri owns Rust watching; Cargo outputs can be locked while linking on Windows.
      ignored: ["**/src-tauri/**", "**/resources/**", "**/release/**", "**/dist-obs/**", "**/.compose-test-data/**"]
    }
  }
});
