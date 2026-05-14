import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell.js";
import "./styles/app.css";
import "./styles/race-profile.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found.");
}

createRoot(rootElement).render(<AppShell />);

