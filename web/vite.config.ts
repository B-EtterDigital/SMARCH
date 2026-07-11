import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4777"
    }
  }
});
