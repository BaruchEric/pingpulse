import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import "@/globals.css";

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- root element is guaranteed in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
