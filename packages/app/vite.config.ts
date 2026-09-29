import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
    // The workers import the vendored CrochetPARADE files from the repo root.
    fs: { allow: [repoRoot] },
  },
  worker: { format: "es" },
});
