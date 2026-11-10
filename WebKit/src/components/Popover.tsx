// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { avoidRegions } from "./Tooltip";
import { computePlacement } from "./tooltipPlacement";
import { usePresence } from "../CoreMotion/presence";
import { MOTION_MS } from "../CoreMotion/motion";
import { Bud } from "../CoreMotion/bud";
import { BudMembrane } from "../CoreMotion/FluidPanel";
import { useSettle } from "../CoreMotion/settle";
import type { Placement, Side } from "./tooltipPlacement";

/**
 * Floating menus and panels.
 *
 * One material and one placement rule for every dropdown in the interface:
 * the panel is measured, then placed on the side of its trigger that clips
 * least and covers the fewest other controls, so a menu near the bottom rail
 * opens upward and one near the right edge slides left. Escape and an outside
 * click close it, and focus returns to the trigger. A menu above or below a
 * bar divides from the bar at its button, the way the dock's panels do.
 */

export function useDismiss(open: boolean, onClose: () => void, inside: RefObject<HTMLElement | null>[]) {
  const close = useRef(onClose);
  close.current = onClose;
  const closeNow = useCallback(() => close.current(), []);
  useSettle(open, closeNow);
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
  only = false,
  edge = false,
  within,
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
  /** Keep to the preferred sides, whatever they cover. */
  only?: boolean;
  /** Above or below, line up with the trigger's nearer edge and be at least as wide, as a pop-up menu does. */
  edge?: boolean;
  /** Stay inside the nearest element this selector matches, 8px in from its sides: a sheet that belongs to a panel. */
  within?: string;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? own;
  const [place, setPlace] = useState<Placement | null>(null);
  const lastAnchorMeasured = useRef(false);
  const measure = useCallback(() => {
    const el = ref.current;
    const a = anchor.current?.getBoundingClientRect();
    if (!el || !a) return;
    const size = el.getBoundingClientRect();
    // A menu from a bar clears the whole bar, not only its button, so it never sits on the bar's edge.
    const bar = anchor.current?.closest(".rail")?.getBoundingClientRect();
    const top = bar ? bar.top : a.top;
    const height = bar ? bar.height : a.height;
    const placed = computePlacement({
        anchor: { left: a.left, top, width: a.width, height },
        tip: { width: size.width, height: size.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        avoid: avoidRegions(anchor.current, 160).filter((r) => (r.weight ?? 1) > 1),
        preferred,
        only,
        gap: 8,
        margin: 12,
      });
    if (edge && (placed.side === "top" || placed.side === "bottom")) {
      const width = Math.max(size.width, a.width);
      const left = a.left + a.width / 2 > window.innerWidth / 2 ? a.right - width : a.left;
      placed.left = Math.max(12, Math.min(window.innerWidth - width - 12, left));
      el.style.minWidth = `${a.width}px`;
    }
    const room = within ? anchor.current?.closest(within)?.getBoundingClientRect() : null;
    if (room) placed.left = Math.max(room.left + 8, Math.min(room.right - 8 - size.width, placed.left));
    setPlace(placed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, preferred.join(), only, edge, within]);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    lastAnchorMeasured.current = true;
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
  // Stays long enough to leave the way it came, unless motion is reduced.
  const lastPlace = useRef<Placement | null>(null);
  if (place) lastPlace.current = place;
  const shown = place ?? (open ? null : lastPlace.current);
  const still = document.documentElement.classList.contains("reduce-motion");
  const parent = still ? null : anchor.current?.closest<HTMLElement>(".rail, .hud-pill, .fabric-appbar");
  const budded = !!parent && (!shown || shown.side === "top" || shown.side === "bottom");
  const leaving = usePresence(open, still ? 0 : budded ? 700 : MOTION_MS.overlay);
  const membrane = useRef<SVGSVGElement>(null);
  const bud = useRef<Bud | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current?.getBoundingClientRect();
    if (!budded || !parent || !shown || !el || !membrane.current || !a) return;
    if (!bud.current) {
      bud.current = new Bud(membrane.current, el, null, () => undefined);
      bud.current.gap = 8;
      bud.current.cut = true;
    }
    const bar = parent.getBoundingClientRect();
    bud.current.place({
      dir: shown.side === "top" ? "up" : "down",
      wall: shown.side === "top" ? bar.top : bar.bottom,
      anchor: a.left + a.width / 2,
      rect: { left: shown.left, top: shown.top, width: el.offsetWidth, height: el.offsetHeight },
      radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 20,
    });
    bud.current.set(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, budded, shown?.left, shown?.top, shown?.side]);
  const gone = !open && !leaving.mounted;
  useEffect(() => {
    if (!gone) return;
    bud.current?.destroy();
    bud.current = null;
  }, [gone]);
  useEffect(() => () => bud.current?.destroy(), []);
  if (gone) return null;
  return createPortal(
    <>
      {budded && <BudMembrane ref={membrane} />}
      <div
        ref={ref}
        id={id}
        role={role}
        aria-label={label}
        className={`floating ${className}${budded ? " budded" : ""}${shown ? ` placed side-${shown.side}` : ""}${!open ? " leaving" : ""}`}
        data-tip-avoid
        style={shown ? { left: shown.left, top: shown.top } : { left: -9999, top: -9999 }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A second line, for options whose name alone does not explain them. */
  description?: string;
  /** Something to look at beside the name, such as colour samples. */
  preview?: ReactNode;
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
    if (restore) trigger.current?.focus({ preventScroll: true });
  }, []);
  useDismiss(open, () => close(false), [trigger, menu]);

  useEffect(() => {
    if (open) {
      setActive(selected);
      requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("[role='listbox']")?.focus({ preventScroll: true }));
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
        {options[selected]?.preview}
        <span className="select-trigger-text">{options[selected]?.label}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Floating anchor={trigger} open={open} preferred={["bottom", "top"]} only edge className="menu" panelRef={menu} role="presentation">
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
              {o.preview}
              <span className="menu-item-text">
                {o.label}
                {o.description && <small>{o.description}</small>}
              </span>
              {i === selected && <Icon name="check" size={14} strokeWidth={2.2} />}
            </div>
          ))}
        </div>
      </Floating>
    </>
  );
}
