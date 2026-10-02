// The eval results page (eval.html), dev only: it reads runs through the
// /__eval middleware in vite.config.ts (packages/eval/src/viewer.ts).

import "@fontsource-variable/fraunces";
import "@fontsource-variable/figtree";
import "@fontsource-variable/jetbrains-mono";
import "../styles.css";
import "./eval.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EvalPage } from "./EvalPage.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EvalPage />
  </StrictMode>,
);
