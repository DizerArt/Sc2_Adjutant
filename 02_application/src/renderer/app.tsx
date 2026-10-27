import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell.js";
import { initializeDesktopBridge } from "./platform/tauri-bridge.js";
import "./styles/app.css";
import "./styles/race-profile.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found.");
}

void initializeDesktopBridge().then(() => {
  createRoot(rootElement).render(<AppShell />);
}).catch((error: unknown) => {
  console.error("Desktop initialization failed", error);
  rootElement.textContent = "Не удалось запустить приложение. Перезапустите SC2 Adjutant.";
});

