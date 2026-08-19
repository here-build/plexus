import "@excalidraw/excalidraw/index.css";

import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App, Connecting } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<Connecting />}>
      <App />
    </Suspense>
  </StrictMode>,
);
