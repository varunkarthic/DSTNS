import { categoryOf, describeNews, focusMatches, NOTIFY_TEMPLATES, severityOf } from "./notificationModel";
import type { NotificationCategory, NotificationSeverity, UiNotification } from "./notificationModel";
import type { News, Topology } from "./types";

/**
 * Notification history.
 *
 * Do Not Disturb decides what is presented, never what is kept: every
 * notification-worthy event is recorded here once, with how it was delivered,
 * whether or not its toast was ever shown. The store is bounded and keyed by
 * event, so re-rendering, regrouping or replaying after a seek can never
 * create a second record for the same event.
 */

export type Delivery =
  /** Presented in the notification capsule. */
  | "shown"
  /** Held back by Do Not Disturb. */
  | "silenced"
  /** Notifications are turned off for this deployment. */
  | "disabled"
  /** Occurred before this view connected, so it was never presented. */
  | "earlier";

export interface HistoryEntry {
  /** `news:<id>` for core events, `focus:<target>` for Auto Focus records. */
  key: string;
  newsId: number | null;
  /** Virtual second the event happened. */
  timestamp: number;
  type: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  summary: string;
  location?: string;
  delivery: Delivery;
  /** Shown only because Auto Focus was following it, despite Do Not Disturb. */
  override: boolean;
  /** Auto Focus framed this event at some point. */
  autoFocused: boolean;
  focusKey?: string;
  details: UiNotification["details"];
  technical: UiNotification["technical"];
}

export interface DeliveryContext {
  /** Ids of notifications currently presented. */
  shownIds: ReadonlySet<string>;
  /** Notifications are enabled at all. */
  enabled: boolean;
  /** Auto Focus is on and following this target, if any. */
  focusKey: string | null;
  /** Would this notification be shown without the Auto Focus override? */
  wouldShow: (n: UiNotification) => boolean;
}

export const HISTORY_LIMIT = 1000;

export class NotificationHistory {
  private entries = new Map<string, HistoryEntry>();
  private ordered: HistoryEntry[] | null = [];
  runId = "";
  /** Changes whenever the contents do, for cheap memoisation. */
  revision = 0;

  constructor(private readonly limit = HISTORY_LIMIT) {}

  reset(runId: string) {
    this.runId = runId;
    this.entries.clear();
    this.ordered = [];
    this.revision += 1;
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Record the notifications just built from arriving events. Each member
   * event is recorded once, with the delivery decided at the moment it first
   * appeared. Returns true when anything was added or changed.
   */
  recordNotifications(list: readonly UiNotification[], news: ReadonlyMap<number, News>, topology: Topology | null, ctx: DeliveryContext): boolean {
    let changed = false;
    for (const n of list) {
      const focused = !!ctx.focusKey && focusMatches(n.focusKey, ctx.focusKey);
      const shown = ctx.shownIds.has(n.id);
      const delivery: Delivery = shown ? "shown" : !ctx.enabled ? "disabled" : "silenced";
      const override = shown && focused && !ctx.wouldShow(n);
      if (!n.newsIds.length) {
        // Synthesised for Auto Focus: one record per followed event.
        const key = `focus:${n.focusKey ?? n.id}`;
        if (this.entries.has(key)) continue;
        this.add({
          key,
          newsId: null,
          timestamp: n.timestamp,
          type: n.type,
          category: n.category,
          severity: n.severity,
          title: n.title,
          summary: n.summary,
          location: n.location,
          delivery,
          override,
          autoFocused: true,
          focusKey: n.focusKey,
          details: n.details,
          technical: n.technical,
        });
        changed = true;
        continue;
      }
      for (const id of n.newsIds) {
        const key = `news:${id}`;
        if (this.entries.has(key)) continue;
        const item = news.get(id);
        if (!item) continue;
        this.add(entryFor(item, topology, delivery, override, focused));
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Record notification-worthy events that were already in the feed when this
   * view connected. They were never presented, and are marked as such.
   */
  recordBacklog(items: readonly News[], topology: Topology | null): boolean {
    let changed = false;
    for (const item of items) {
      if (!NOTIFY_TEMPLATES.has(item.template_id) || this.entries.has(`news:${item.news_id}`)) continue;
      this.add(entryFor(item, topology, "earlier", false, false));
      changed = true;
    }
    return changed;
  }

  /** Mark every record describing the target Auto Focus is now framing. */
  markFocused(targetKey: string | null): boolean {
    if (!targetKey) return false;
    let changed = false;
    for (const entry of this.entries.values())
      if (!entry.autoFocused && focusMatches(entry.focusKey, targetKey)) {
        entry.autoFocused = true;
        changed = true;
      }
    if (changed) this.touch();
    return changed;
  }

  /** Newest first. */
  list(): readonly HistoryEntry[] {
    if (!this.ordered) {
      this.ordered = [...this.entries.values()].sort(
        (a, b) => b.timestamp - a.timestamp || (b.newsId ?? Infinity) - (a.newsId ?? Infinity),
      );
    }
    return this.ordered;
  }

  counts(): Record<Delivery | "all" | "autoFocused", number> {
    const c = { all: 0, shown: 0, silenced: 0, disabled: 0, earlier: 0, autoFocused: 0 };
    for (const e of this.entries.values()) {
      c.all += 1;
      c[e.delivery] += 1;
      if (e.autoFocused) c.autoFocused += 1;
    }
    return c;
  }

  private add(entry: HistoryEntry) {
    this.entries.set(entry.key, entry);
    if (this.entries.size > this.limit) {
      // Drop the oldest by event time, keeping the store bounded.
      const oldest = [...this.entries.values()].reduce((a, b) => (b.timestamp < a.timestamp ? b : a));
      this.entries.delete(oldest.key);
    }
    this.touch();
  }

  private touch() {
    this.ordered = null;
    this.revision += 1;
  }
}

function entryFor(item: News, topology: Topology | null, delivery: Delivery, override: boolean, focused: boolean): HistoryEntry {
  const d = describeNews(item, topology);
  return {
    key: `news:${item.news_id}`,
    newsId: item.news_id,
    timestamp: item.virtual_day_s,
    type: item.template_id,
    category: categoryOf(item.category),
    severity: severityOf(item.severity),
    title: d.title,
    summary: d.summary,
    location: d.location,
    delivery,
    override,
    autoFocused: focused,
    focusKey: d.focusKey,
    details: d.details,
    technical: d.technical,
  };
}

export type HistoryFilter = "all" | "shown" | "silenced" | "autoFocused";

export function filterHistory(entries: readonly HistoryEntry[], filter: HistoryFilter): readonly HistoryEntry[] {
  if (filter === "all") return entries;
  if (filter === "autoFocused") return entries.filter((e) => e.autoFocused);
  return entries.filter((e) => e.delivery === filter);
}

export const DELIVERY_LABEL: Record<Delivery, string> = {
  shown: "Shown",
  silenced: "Silenced",
  disabled: "Notifications off",
  earlier: "Before this session",
};
