import { useState } from "react";
import { groupNotifications, notificationBody, stackLabel } from "./notificationGroups";
import type { News } from "./types";

/**
 * On-screen notifications, grouped by kind.
 *
 * A burst of forty flood reports collapses to one card that says so. Clicking
 * it expands the members; clicking again collapses them. Dismissing a
 * collapsed stack dismisses everything in it, which is what someone who has
 * read "40 events" and moved on actually means.
 */
export function Notifications({
  items,
  maxVisible,
  onDismiss,
  reduceMotion,
}: {
  items: News[];
  maxVisible: number;
  onDismiss: (ids: number[]) => void;
  reduceMotion: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const groups = groupNotifications(items).slice(0, maxVisible);
  if (!groups.length) return null;

  return (
    <div className="toasts" aria-live="polite">
      {groups.map((group) => {
        const open = expanded === group.key;
        const count = group.items.length;
        return (
          <article
            key={group.key}
            className={`toast glass${group.stacked ? " stacked" : ""}${open ? " open" : ""}${
              reduceMotion ? " still" : ""
            }`}
          >
            {/* The shoulders of the cards beneath, so a stack reads as depth
                rather than as a number on a flat card. */}
            {group.stacked && !open && (
              <>
                <i className="stack-under one" aria-hidden="true" />
                {count > 2 && <i className="stack-under two" aria-hidden="true" />}
              </>
            )}

            <div className="toast-head">
              <span className="eyebrow">{group.category}</span>
              <div className="toast-actions">
                {group.stacked && (
                  <button
                    className="toast-count"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : group.key)}
                  >
                    {open ? "Collapse" : stackLabel(count)}
                  </button>
                )}
                <button
                  aria-label={
                    group.stacked
                      ? `Dismiss ${stackLabel(count)}`
                      : "Dismiss notification"
                  }
                  onClick={() => onDismiss(group.items.map((n) => n.news_id))}
                >
                  ×
                </button>
              </div>
            </div>

            {open ? (
              <ul className="toast-list">
                {group.items.map((item) => (
                  <li key={item.news_id}>
                    <span className="mono">{item.simulated_current_time}</span>
                    <span>{notificationBody(item)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{notificationBody(group.latest)}</p>
            )}
          </article>
        );
      })}
    </div>
  );
}
