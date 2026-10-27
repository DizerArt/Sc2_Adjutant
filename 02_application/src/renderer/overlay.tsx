import { createRoot } from "react-dom/client";
import { OverlayShell } from "./components/OverlayShell.js";
import { initializeDesktopBridge } from "./platform/tauri-bridge.js";
import "./styles/overlay.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found.");
}

void initializeDesktopBridge().then(() => {
  createRoot(rootElement).render(<OverlayShell />);
}).catch((error: unknown) => {
  // Keep a failed transparent overlay empty rather than exposing an error on stream.
  console.error("Overlay initialization failed", error);
});
