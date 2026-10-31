// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import fabricWhite from "./assets/brand/fabric-white.png";
import fabricBlack from "./assets/brand/fabric-black.png";
import webfabricWhite from "./assets/brand/webfabric-white.png";
import webfabricBlack from "./assets/brand/webfabric-black.png";

const SOURCES = {
  fabric: { alt: "Fabric", dark: fabricWhite, light: fabricBlack },
  webfabric: { alt: "WebFabric", dark: webfabricWhite, light: webfabricBlack },
};

/** A subsystem's logo in the official drawing for the theme: never filtered or recoloured. */
export function BrandLogo({ name, height = 18 }: { name: keyof typeof SOURCES; height?: number }) {
  const logo = SOURCES[name];
  return (
    <span className="brand-logo" role="img" aria-label={logo.alt} style={{ height }}>
      <img className="for-dark" src={logo.dark} alt="" height={height} />
      <img className="for-light" src={logo.light} alt="" height={height} />
    </span>
  );
}
