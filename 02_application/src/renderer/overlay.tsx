import { createRoot } from "react-dom/client";
import { OverlayShell } from "./components/OverlayShell.js";
import "./styles/overlay.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found.");
}

createRoot(rootElement).render(<OverlayShell />);
