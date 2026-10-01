import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // The workers import the vendored CrochetPARADE files from the repo root.
    fs: { allow: [repoRoot] },
    // The API server (npm run server). One origin for the app and the API, so
    // the session cookie and the CSRF origin check need no CORS.
    proxy: { "/api": "http://127.0.0.1:5181" },
  },
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("index.html", import.meta.url)),
        harness: fileURLToPath(new URL("harness.html", import.meta.url)),
      },
    },
  },
});
