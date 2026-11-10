// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Figure, type FigureName } from "../CoreMotion/Figure";

/**
 * The one modal surface.
 *
 * Every dialog shares this shell: a blurred scrim that keeps the map legible
 * behind the dialog, a focus trap, Escape to dismiss, and a paired entry and
 * exit transition so nothing ever appears or vanishes abruptly.
 */

export function Dialog({
  onClose,
  labelledBy,
  children,
  closing = false,
  className = "",
  scrimClassName = "",
  role = "dialog",
  figure,
  tone,
}: {
  /** Escape and a press outside call this. Without it the dialog can only be answered. */
  onClose?: () => void;
  labelledBy: string;
  children: ReactNode;
  closing?: boolean;
  className?: string;
  scrimClassName?: string;
  role?: "dialog" | "alertdialog";
  /** Drawn on a plate beside the words: what the dialog is about, acted out. */
  figure?: FigureName;
  tone?: "danger";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);

  useEffect(() => {
    restore.current = document.activeElement;
    // Move focus into the dialog so keyboard users are not left behind it.
    const first = panel.current?.querySelector<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    (first ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      (restore.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className={`scrim${closing ? " closing" : ""} ${scrimClassName}`.trimEnd()}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panel}
        className={`dialog glass${tone ? ` ${tone}` : ""} ${className}`.trimEnd()}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {figure ? (
          <>
            <div className="dialog-plate">
              <Figure name={figure} />
            </div>
            <div className="dialog-main">{children}</div>
          </>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
