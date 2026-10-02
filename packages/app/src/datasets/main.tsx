// The datasets page (datasets.html), dev only: it reads the downloaded
// datasets and runs through the /__eval middleware in vite.config.ts
// (packages/eval/src/viewer.ts).

import "@fontsource-variable/fraunces";
import "@fontsource-variable/figtree";
import "@fontsource-variable/jetbrains-mono";
import "../styles.css";
import "../eval/eval.css";
import "./datasets.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DatasetsPage } from "./DatasetsPage.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DatasetsPage />
  </StrictMode>,
);
