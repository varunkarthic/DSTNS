// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { Topology } from "./types";

/**
 * Names in the language a viewer reads: each road's and place's OpenStreetMap `name:<lang>` where it has one, and its
 * own `name` otherwise. Display only: which city a seed chooses, and every hash, are the server's and never see this.
 * "local" keeps the names as the map has them.
 */
export const LABEL_LANGUAGES = ["local", "en", "fr", "de", "es", "it", "pt", "nl", "ru", "ar", "hi", "ja", "ko", "zh", "tr"] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];
export const LANGUAGE_NAMES: Record<LabelLanguage, string> = {
  local: "As the map names them", en: "English", fr: "French", de: "German", es: "Spanish", it: "Italian", pt: "Portuguese",
  nl: "Dutch", ru: "Russian", ar: "Arabic", hi: "Hindi", ja: "Japanese", ko: "Korean", zh: "Chinese", tr: "Turkish",
};

export function localName(tags: Record<string, string> | undefined, name: string, language: string): string {
  if (language === "local" || !tags) return name;
  return tags[`name:${language}`]?.trim() || name;
}

/** The topology with its names in `language`; the same object when nothing changes. */
export function localiseNames<T extends Topology | null | undefined>(topology: T, language: string): T {
  if (!topology || language === "local") return topology;
  return {
    ...topology,
    edges: topology.edges.map((e) => {
      const name = localName(e.tags, e.name, language);
      return name === e.name ? e : { ...e, name };
    }),
    features: topology.features.map((f) => {
      const name = localName(f.tags, f.name, language);
      return name === f.name ? f : { ...f, name };
    }),
  };
}
