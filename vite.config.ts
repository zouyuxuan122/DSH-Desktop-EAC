import { defineConfig } from "vite";

// Tauri expects a fixed dev port; fail instead of picking a random one.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 14200,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
