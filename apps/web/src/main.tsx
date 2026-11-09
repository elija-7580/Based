import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyAppearance, loadAppearance } from "./appearance.js";
import "./styles.css";

// Vor dem ersten Rendern setzen, damit Dunkel nicht hell aufblitzt.
applyAppearance(loadAppearance());
const root = document.getElementById("root");
if (!root) throw new Error("#root fehlt");
createRoot(root).render(<StrictMode><App /></StrictMode>);
