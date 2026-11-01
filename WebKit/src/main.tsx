// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import "./style.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installMotionTokens } from "./motion";
import { applyLaunchDefaults } from "./uiConfig";

applyLaunchDefaults();
installMotionTokens();
// The last screen is drawn after the server has gone, when nothing more can be fetched.
void document.fonts?.load('500 48px "Space Grotesk"');

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
