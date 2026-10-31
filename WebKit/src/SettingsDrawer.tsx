// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useScrollFade } from "./scrollFade";
import { useEffect, useRef, useState } from "react";
import { FluidPanel } from "./FluidPanel";
import { QuantizedSlider } from "./QuantizedSlider";
import { Select } from "./Popover";
import { Icon } from "./Icons";
import { Badge, Row, Section, Segmented, Switch } from "./settingsControls";
import { COLOR_VISION_OPTIONS } from "./appearance";
import type { ColorVision, ThemeSetting } from "./appearance";
import type { ByteUnits } from "./units";
import { useFabricApps } from "./webfabric/store";
import { WebFabricSettings } from "./webfabric/Settings";
import { BrandLogo } from "./BrandLogo";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from "./notificationModel";
import { SKIP_OPTIONS, STEP_OPTIONS } from "./uiConfig";
import type { AutoFocusStrategy, NewsStyle } from "./uiConfig";
import { REALISTIC_NEWS } from "./notificationModel";
import { formatDuration } from "./timeFormat";

/**
 * Settings, as a drawer that slides from the left edge over the map.
 *
 * Sections are self-contained so further settings can be added without
 * reorganising the drawer. Every setting here is a presentation choice: none
 * of it reaches the simulation.
 */

export interface SettingsValues {
  autoFocus: boolean;
  autoFocusAvailable: boolean;
  strategy: AutoFocusStrategy;
  dnd: boolean;
  mutedCategories: string[];
  mutedSeverities: string[];
  hour12: boolean;
  reduceMotion: boolean;
  motionLocked: boolean;
  skipSeconds: number;
  stepSeconds: number;
  newsStyle: NewsStyle;
  /** Whether the core's narrator can write Realistic News right now. */
  realisticAvailable: boolean;
  narratorNote: string;
  /** A short reason, when Realistic News cannot run here. */
  narratorBadge?: string;
  theme: ThemeSetting;
  colorVision: ColorVision;
  reduceTransparency: boolean;
  advanced: boolean;
  byteUnits: ByteUnits;
  fineControl: boolean;
}

export interface SettingsActions {
  onReset: () => void;
  onAutoFocus: (on: boolean) => void;
  onStrategy: (s: AutoFocusStrategy) => void;
  onDnd: (on: boolean) => void;
  onMutedCategories: (ids: string[]) => void;
  onMutedSeverities: (ids: string[]) => void;
  onHour12: (on: boolean) => void;
  onReduceMotion: (on: boolean) => void;
  onSkipSeconds: (s: number) => void;
  onStepSeconds: (s: number) => void;
  onNewsStyle: (style: NewsStyle) => void;
  onTheme: (theme: ThemeSetting) => void;
  onColorVision: (vision: ColorVision) => void;
  onReduceTransparency: (on: boolean) => void;
  onAdvanced: (on: boolean) => void;
  onByteUnits: (units: ByteUnits) => void;
  onFineControl: (on: boolean) => void;
}

const shortDuration = (seconds: number) => (seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`);

function toggle(list: string[], id: string, on: boolean, order: string[]) {
  const next = new Set(list);
  if (on) next.add(id);
  else next.delete(id);
  return order.filter((x) => next.has(x));
}

export function SettingsDrawer({
  open,
  onClose,
  values,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  values: SettingsValues;
  actions: SettingsActions;
}) {
  const reduceMotion = values.reduceMotion;
  const [page, setPage] = useState<"main" | "webfabric">("main");
  const apps = useFabricApps();
  const waitingApps = apps.filter((app) => app.capabilities.pending.length > 0 && app.state !== "unloaded").length;
  const scroll = useScrollFade<HTMLDivElement>();
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  const categoryOrder = NOTIFICATION_CATEGORIES.map((c) => c.id as string);
  const severityOrder = NOTIFICATION_SEVERITIES.map((c) => c.id as string);

  return (
    <FluidPanel ref={panel} open={open} anchor="[data-settings-trigger]" label="Settings" className="settings-drawer" width={392} reduceMotion={reduceMotion}>
      <header className="settings-head">
        <h2>Settings</h2>
        <button ref={closeRef} type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>

      <div {...scroll} className={`settings-scroll ${scroll.className}`} tabIndex={0} aria-label="Settings preferences">
        {page === "webfabric" ? (
          <WebFabricSettings onBack={() => setPage("main")} />
        ) : (
        <>
        <button type="button" className="btn" onClick={actions.onReset}><Icon name="reset" size={16} />Reset settings</button>
        <Section title="Accessibility" icon="eye">
          <Row
            stacked
            title="Appearance"
            hint={values.theme === "system" ? "Follows this device." : undefined}
            control={
              <Segmented
                label="Appearance"
                value={values.theme}
                onChange={actions.onTheme}
                options={[
                  { value: "dark", label: "Dark", icon: "moon" },
                  { value: "light", label: "Light", icon: "sun" },
                  { value: "system", label: "Auto", icon: "system" },
                ]}
              />
            }
          />
          <Row
            stacked
            title="Colour vision"
            hint={COLOR_VISION_OPTIONS.find((o) => o.value === values.colorVision)?.hint}
            control={<Select label="Colour vision" className="wide" value={values.colorVision} onChange={actions.onColorVision} options={COLOR_VISION_OPTIONS} />}
          />
          <Row
            title="Reduce motion"
            icon="motionOff"
            hint={values.motionLocked ? undefined : "Replaces movement with short fades, and stills flow markers."}
            badge={values.motionLocked ? <Badge tone="warn">Held by backpressure</Badge> : undefined}
            htmlFor="set-motion"
            control={<Switch id="set-motion" label="Reduce motion" checked={values.reduceMotion} disabled={values.motionLocked} onChange={actions.onReduceMotion} />}
          />
          <Row
            title="Reduce transparency"
            icon="layers"
            hint="Solid surfaces, for stronger contrast."
            htmlFor="set-transparency"
            control={<Switch id="set-transparency" label="Reduce transparency" checked={values.reduceTransparency} onChange={actions.onReduceTransparency} />}
          />
          <Row
            title="Advanced mode"
            icon="sliders"
            hint="Shows demand multipliers, radii, identifiers and technical details."
            htmlFor="set-advanced"
            control={<Switch id="set-advanced" label="Advanced mode" checked={values.advanced} onChange={actions.onAdvanced} />}
          />
        </Section>

        <Section title="Auto Focus" icon="focus">
          <Row
            title="Auto Focus Events"
            badge={values.autoFocusAvailable ? undefined : <Badge>Off for this deployment</Badge>}
            hint={values.autoFocusAvailable ? "Automatically follow significant simulation events. The camera frames each event's full footprint." : undefined}
            htmlFor="set-autofocus"
            control={
              <Switch id="set-autofocus" label="Auto Focus Events" checked={values.autoFocus} disabled={!values.autoFocusAvailable} onChange={actions.onAutoFocus} />
            }
          />
          <Row
            stacked
            title="Order"
            hint={values.strategy === "round-robin" ? "Visit every live event in turn." : "Stay on the most recent event."}
            control={
              <Segmented
                label="Auto Focus order"
                value={values.strategy}
                disabled={!values.autoFocusAvailable}
                onChange={actions.onStrategy}
                options={[
                  { value: "round-robin", label: "Round-Robin", icon: "reroll" },
                  { value: "latest", label: "Latest", icon: "clock" },
                ]}
              />
            }
          />
        </Section>

        <Section title="Do Not Disturb" icon="bellOff">
          <Row
            title="Do Not Disturb"
            hint="Suppress selected notification categories. Events are still recorded and reported."
            htmlFor="set-dnd"
            control={<Switch id="set-dnd" label="Do Not Disturb" checked={values.dnd} onChange={actions.onDnd} />}
          />
          <fieldset className={`settings-checks${values.dnd ? "" : " dimmed"}`}>
            <legend>Muted categories</legend>
            {NOTIFICATION_CATEGORIES.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={values.mutedCategories.includes(c.id)}
                  onChange={(e) => actions.onMutedCategories(toggle(values.mutedCategories, c.id, e.target.checked, categoryOrder))}
                />
                <span className="check-box" aria-hidden="true">
                  <Icon name="check" size={14} strokeWidth={2.4} />
                </span>
                <span className="check-text">
                  {c.label}
                  <small>{c.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className={`settings-checks compact${values.dnd ? "" : " dimmed"}`}>
            <legend>Muted severities</legend>
            {NOTIFICATION_SEVERITIES.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={values.mutedSeverities.includes(c.id)}
                  onChange={(e) => actions.onMutedSeverities(toggle(values.mutedSeverities, c.id, e.target.checked, severityOrder))}
                />
                <span className="check-box" aria-hidden="true">
                  <Icon name="check" size={14} strokeWidth={2.4} />
                </span>
                <span className="check-text">{c.label}</span>
              </label>
            ))}
          </fieldset>
          <p className="settings-note">
            When Auto Focus moves the camera to an event, that event's notification is shown even if its category is muted.
          </p>
        </Section>

        <Section title="News" icon="news">
          <Row
            stacked
            title="News style"
            badge={values.narratorBadge ? <Badge tone="warn">{values.narratorBadge}</Badge> : undefined}
            hint={
              values.realisticAvailable
                ? values.newsStyle === "realistic"
                  ? values.narratorNote
                  : "Predefined wordings, varied from event to event."
                : `${values.narratorNote} Standard wording is used.`
            }
            control={
              <Segmented
                label="News style"
                value={values.realisticAvailable ? values.newsStyle : "standard"}
                disabled={!values.realisticAvailable}
                onChange={actions.onNewsStyle}
                options={[
                  { value: "realistic", label: REALISTIC_NEWS },
                  { value: "standard", label: "Standard" },
                ]}
              />
            }
          />
        </Section>

        <Section title="Time and playback" icon="clock">
          <Row
            stacked
            title="Time format"
            hint="Applies to every simulation timestamp."
            control={
              <Segmented
                label="Time format"
                value={values.hour12 ? "12" : "24"}
                onChange={(v) => actions.onHour12(v === "12")}
                options={[
                  { value: "24", label: "24 hour" },
                  { value: "12", label: "12 hour" },
                ]}
              />
            }
          />
          <Row
            stacked
            title="Back and Forward"
            hint="Virtual time skipped per press."
            control={
              <QuantizedSlider
                label="Skip interval"
                reduceMotion={reduceMotion}
                labels={SKIP_OPTIONS.map(shortDuration)}
                index={Math.max(0, SKIP_OPTIONS.indexOf(values.skipSeconds as never))}
                valueText={(i) => formatDuration(SKIP_OPTIONS[i])}
                onSelect={(i) => actions.onSkipSeconds(SKIP_OPTIONS[i])}
              />
            }
          />
          <Row
            title="Fine control"
            icon="sliders"
            hint="Back and Forward ask how far each time, so you need not come here."
            htmlFor="set-fine"
            control={<Switch id="set-fine" label="Fine control" checked={values.fineControl} onChange={actions.onFineControl} />}
          />
          <Row
            stacked
            title="Step"
            hint="Virtual time advanced per step. The run holds after each step."
            control={
              <QuantizedSlider
                label="Step interval"
                reduceMotion={reduceMotion}
                labels={STEP_OPTIONS.map(shortDuration)}
                index={Math.max(0, STEP_OPTIONS.indexOf(values.stepSeconds as never))}
                valueText={(i) => formatDuration(STEP_OPTIONS[i])}
                onSelect={(i) => actions.onStepSeconds(STEP_OPTIONS[i])}
              />
            }
          />
        </Section>

        <Section title="Units" icon="gauge">
          <Row
            stacked
            title="Data sizes"
            hint={values.byteUnits === "decimal" ? "Base 10: 1 MB is 1,000,000 bytes." : "Base 2: 1 MiB is 1,048,576 bytes."}
            control={
              <Segmented
                label="Data sizes"
                value={values.byteUnits}
                onChange={actions.onByteUnits}
                options={[
                  { value: "decimal", label: "MB" },
                  { value: "binary", label: "MiB" },
                ]}
              />
            }
          />
        </Section>

        <Section title="Applications" icon="stack">
          <button type="button" className="settings-nav" onClick={() => setPage("webfabric")}>
            <BrandLogo name="webfabric" height={16} />
            <small>
              {waitingApps > 0 && <Badge tone="warn">{waitingApps} waiting</Badge>}
              {apps.length === 1 ? "1 application" : `${apps.length} applications`}
              <Icon name="chevronRight" size={14} />
            </small>
          </button>
        </Section>
        </>
        )}
      </div>
    </FluidPanel>
  );
}
