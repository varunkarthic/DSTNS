// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import type { News } from "./types";

/**
 * Notification grouping.
 *
 * A simulated day produces events in bursts: a storm cell floods forty roads
 * within a few virtual seconds, each one a separate message. Shown one per
 * card they bury the screen and each other. Grouped, forty become one card
 * that says so and can be opened.
 *
 * Grouping is by *kind*, not by exact text, so "Flooding detected on Edge 1710"
 * and "Flooding detected on Edge 3616" land together while an unrelated
 * incident stays its own card.
 */

export interface NotificationGroup {
  /** Stable identity for this kind of event, used as the React key. */
  key: string;
  /** What the group is about, with the varying part removed. */
  title: string;
  category: string;
  /** Newest first. */
  items: News[];
  /** The most recent member, which is what the collapsed card shows. */
  latest: News;
  /** True when this group stands for more than one event. */
  stacked: boolean;
}

/**
 * The part of a message that identifies its kind.
 *
 * Entity references are what vary within a burst, so they are the part to
 * drop: edge and node numbers, coordinates, times, and bracketed prefixes.
 */
export function notificationKind(item: News): string {
  const body = item.message.replace(/^\[.*?\]\s*/, "");
  return body
    .replace(/\b(edge|node|junction|road|link|signal|incident|cell)\s+#?\d+/gi, "$1")
    .replace(/#\d+/g, "")
    .replace(/\b\d+[.:]\d+[.:]?\d*\b/g, "")
    // A lookahead rather than \b: "%" is not a word character, so \b after it
    // only matches before a letter and "40% at" would keep its number.
    .replace(/\b\d+(\.\d+)?\s?(%|km\/h|mm\/h|km|min|m|s)(?![\w])/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Strip the leading "[CATEGORY]" a message may carry. */
export function notificationBody(item: News): string {
  return item.message.replace(/^\[.*?\]\s*/, "");
}

/**
 * Collapse a list of notifications into groups, newest group first.
 *
 * Order is by the newest member of each group, so a fresh event always
 * surfaces its group to the top rather than being buried inside an older one.
 */
export function groupNotifications(items: News[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();

  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.news_id)) continue;
    seen.add(item.news_id);
    const kind = notificationKind(item);
    const key = `${item.category}::${item.template_id}::${kind || item.message}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      // Keep `latest` genuinely latest: input order is not guaranteed.
      if (item.news_id > existing.latest.news_id) existing.latest = item;
      existing.stacked = true;
    } else {
      groups.set(key, {
        key,
        title: kind || notificationBody(item),
        category: item.category,
        items: [item],
        latest: item,
        stacked: false,
      });
    }
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      items: [...g.items].sort((a, b) => b.news_id - a.news_id),
    }))
    .sort((a, b) => b.latest.news_id - a.latest.news_id);
}

/** "3 events" / "1 event", for the stack badge. */
export function stackLabel(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}
