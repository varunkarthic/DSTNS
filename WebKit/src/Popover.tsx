// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { avoidRegions } from "./Tooltip";
import { computePlacement } from "./tooltipPlacement";
import type { Placement, Side } from "./tooltipPlacement";

/**
 * Floating menus and panels.
 *
 * One material and one placement rule for every dropdown in the interface:
 * the panel is measured, then placed on the side of its trigger that clips
 * least and covers the fewest other controls, so a menu near the bottom rail
 * opens upward and one near the right edge slides left. Escape and an outside
 * click close it, and focus returns to the trigger.
 */

export function useDismiss(open: boolean, onClose: () => void, inside: RefObject<HTMLElement | null>[]) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && inside.some((r) => r.current?.contains(target))) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
    // The refs are stable for the lifetime of the popover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export function Floating({
  anchor,
  open,
  preferred = ["top", "bottom", "right", "left"],
  className = "",
  children,
  panelRef,
  role = "dialog",
  label,
  id,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  preferred?: Side[];
  className?: string;
  children: ReactNode;
  panelRef?: RefObject<HTMLDivElement | null>;
  role?: string;
  label?: string;
  id?: string;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? own;
  const [place, setPlace] = useState<Placement | null>(null);
  const measure = useCallback(() => {
    const el = ref.current;
    const a = anchor.current?.getBoundingClientRect();
    if (!el || !a) return;
    const size = el.getBoundingClientRect();
    setPlace(
      computePlacement({
        anchor: { left: a.left, top: a.top, width: a.width, height: a.height },
        tip: { width: size.width, height: size.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        avoid: avoidRegions(anchor.current, 160).filter((r) => (r.weight ?? 1) > 1),
        preferred,
        gap: 8,
        margin: 12,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, preferred.join()]);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    measure();
    if (typeof ResizeObserver === "undefined" || !ref.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, measure, ref]);
  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      className={`floating ${className}${place ? ` placed side-${place.side}` : ""}`}
      data-tip-avoid
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A custom single-choice dropdown. The trigger is a button, the menu a
 * listbox: arrow keys, Home and End move, Enter or Space choose, Escape
 * closes, and typing a letter jumps to the first option that starts with it.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
  disabled = false,
}: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  const close = useCallback((restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);
  useDismiss(open, () => close(false), [trigger, menu]);

  useEffect(() => {
    if (open) {
      setActive(selected);
      requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("[role='listbox']")?.focus());
    }
  }, [open, selected]);

  const choose = (i: number) => {
    onChange(options[i].value);
    close();
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const last = options.length - 1;
    if (e.key === "ArrowDown") setActive((i) => Math.min(last, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1) {
      const i = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setActive(i);
      return;
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`select-trigger ${className}${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${options[selected]?.label ?? ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{options[selected]?.label}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Floating anchor={trigger} open={open} preferred={["bottom", "top"]} className="menu" panelRef={menu} role="presentation">
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onKey}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === selected}
              className={`menu-item${i === active ? " active" : ""}${i === selected ? " selected" : ""}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span>{o.label}</span>
              {i === selected && <Icon name="check" size={14} strokeWidth={2.2} />}
            </div>
          ))}
        </div>
      </Floating>
    </>
  );
}
