import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { evalViewerMiddleware } from "../eval/src/viewer.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// The eval results page (eval.html) reads the git-ignored run directories
// through this; dev only, so no dataset text reaches a build.
const evalRuns: Plugin = {
  name: "eval-runs",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__eval", evalViewerMiddleware());
  },
};

export default defineConfig({
  plugins: [react(), evalRuns],
  server: {
    port: 5180,
    strictPort: true,
    // The workers import the vendored CrochetPARADE files from the repo root.
    fs: { allow: [repoRoot] },
    // The API server (npm run server). One origin for the app and the API, so
    // the session cookie and the CSRF origin check need no CORS. API_PORT
    // points a second copy at a second server.
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 5181}` },
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
