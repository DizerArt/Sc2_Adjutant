import { createRoot } from "react-dom/client";
import { ObsOverlayCanvas } from "./components/ObsOverlayCanvas.js";
import "./styles/overlay.css";
import "./styles/obs-overlay.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<ObsOverlayCanvas />);
