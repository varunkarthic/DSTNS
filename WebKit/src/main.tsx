// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import "./styles/style.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installMotionTokens } from "./CoreMotion/motion";
import { applyLaunchDefaults } from "./core/uiConfig";

applyLaunchDefaults();
installMotionTokens();
// The last screen is drawn after the server has gone, when nothing more can be fetched.
void document.fonts?.load('500 48px "Space Grotesk"');

// A focus ring is for finding your way with Tab. Clicking a control and then pressing a
// shortcut or an arrow key should not leave one on it.
document.addEventListener("keydown", (e) => { if (e.key === "Tab") document.documentElement.dataset.input = "tab"; }, true);
document.addEventListener("pointerdown", () => { delete document.documentElement.dataset.input; }, true);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
