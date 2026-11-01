// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { formatBytes } from "./units";
import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { filmAvailable } from "./BootScene";
import { LoadingSurface } from "./LoadingSurface";
import type { BootPhase } from "./LoadingSurface";
import { Mark } from "./Logo";

/**
 * Start-up screen.
 *
 * The interface starts before the core has a map: a district is often being
 * downloaded from OpenStreetMap, which takes tens of seconds. The start-up
 * screen reports what is actually happening, stage by stage, and dissolves
 * into the map the moment the first network has arrived: it holds nothing back.
 */

/**
 * The stages between opening the interface and watching a live world, in
 * order. Each one is entered only when the core reports it: the world is
 * chosen while the scenario compiles, the map is downloaded only when it is
 * not already cached, and the last stage ends when the first network arrives.
 */
export const BOOT_STEPS = [
  { id: "interface", label: "Starting interface" },
  { id: "select", label: "Selecting world" },
  { id: "download", label: "Downloading map" },
  { id: "generate", label: "Generating world" },
  { id: "initialize", label: "Initializing simulation" },
] as const;

export interface SplashStage {
  /** Short phrase: what is happening right now. */
  label: string;
  /** Longer explanation, when there is something worth saying. */
  detail?: string;
  /** 0..1 when the core knows, undefined when it does not. */
  progress?: number;
  /** Index into BOOT_STEPS; stages passed quickly (a cached map) count as done. */
  step: number;
  /** No run exists yet, so there is nothing to load until one is started. */
  waiting?: boolean;
}

const TITLE_WAIT_MS = 1000;
const TITLE_HOLD_MS = 2200;
// Each stage has the screen for at least this long, including those the core has already
// passed, so a fast start-up can still be seen from the beginning.
const STAGE_MIN_MS = 1100;
// A launcher asks for its world just as the film begins, so no one should be told to
// start one in the meantime.
const WAITING_GRACE_MS = 3500;

const STAGE_DETAIL = ["Opening the observer", "Resolving the seed to a city district", "Reading the district's map data", "Building the road graph, signals and schedules", "Receiving roads, places and the first state"];

/**
 * The opening: nothing, then the title, then the film. A page opened on a world already
 * running has seen this, or does not need to, and goes straight in.
 */
export function useBootPhase(live: boolean | null): BootPhase {
  const [phase, setPhase] = useState<BootPhase>("blank");
  useEffect(() => {
    if (live) {
      setPhase("film");
      return;
    }
    const title = setTimeout(() => setPhase((old) => (old === "blank" ? "title" : old)), TITLE_WAIT_MS);
    const film = setTimeout(() => setPhase("film"), TITLE_WAIT_MS + TITLE_HOLD_MS);
    return () => {
      clearTimeout(title);
      clearTimeout(film);
    };
  }, [live]);
  return phase;
}

/**
 * What the start-up screen shows, one stage at a time. It only ever shows stages the core
 * has reached, a little later than it reached them, and `holding` keeps the screen up
 * until the last has been seen.
 */
export function usePacedStages(real: SplashStage | null, phase: BootPhase, enabled: boolean, filmSeen = true): { stage: SplashStage | null; holding: boolean } {
  const [shown, setShown] = useState(0);
  const [graceOver, setGraceOver] = useState(false);
  const running = enabled && phase === "film";
  const goal = real ? real.step : BOOT_STEPS.length;
  useEffect(() => {
    if (!running || graceOver) return;
    const timer = setTimeout(() => setGraceOver(true), WAITING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [running, graceOver]);
  useEffect(() => {
    if (!running || shown >= goal) return;
    const timer = setTimeout(() => setShown((step) => step + 1), STAGE_MIN_MS);
    return () => clearTimeout(timer);
  }, [running, shown, goal]);
  if (!enabled) return { stage: real, holding: false };
  // Ready, and the whole film has been seen: nothing keeps it here. Ready, but the film is
  // not finished: it plays to its end, as it is part of arriving. Once it has been through
  // once, this screen leaves the moment the world is ready, wherever the film has got to.
  if (!real && shown >= BOOT_STEPS.length) {
    if (filmSeen) return { stage: null, holding: false };
    return { stage: { step: BOOT_STEPS.length - 1, label: "Finishing setup", detail: "Setting up the interface" }, holding: true };
  }
  const step = Math.min(shown, BOOT_STEPS.length - 1);
  const holding = phase !== "film" || shown < goal || (!real && shown < BOOT_STEPS.length) || !filmSeen;
  if (real?.waiting) {
    if (graceOver) return { stage: real, holding: false };
    return { stage: { step: 0, label: BOOT_STEPS[0].label, detail: STAGE_DETAIL[0] }, holding: true };
  }
  if (real && shown >= real.step) return { stage: real, holding };
  return { stage: { step, label: BOOT_STEPS[step].label, detail: STAGE_DETAIL[step] }, holding };
}

export const LICENCE = "Deterministic Spatiotemporal Transport Network Simulator · © 2026 Varun Karthic · AGPL-3.0-or-later · Map data © OpenStreetMap contributors (ODbL)";

export function Splash({
  stage,
  reduceMotion,
  closing = false,
  landing,
  phase,
  quick = false,
  onFilmCycle,
}: {
  stage: SplashStage;
  reduceMotion: boolean;
  closing?: boolean;
  landing?: () => Float32Array | null;
  phase?: BootPhase;
  quick?: boolean;
  onFilmCycle?: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const clock = setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(clock);
    };
  }, []);

  return (
    <LoadingSurface
      mode="boot"
      eyebrow={stage.waiting ? "Welcome to DSTNS" : undefined}
      title={stage.label}
      status={stage.waiting || elapsed < 15 ? stage.detail : `${stage.detail ?? "Working"} · ${elapsed} s`}
      steps={stage.waiting ? undefined : BOOT_STEPS}
      stepIndex={stage.step}
      progress={stage.progress}
      progressLabel={stage.label}
      idle={stage.waiting}
      landing={landing}
      phase={phase}
      quick={quick}
      onFilmCycle={onFilmCycle}
      closing={closing}
      reduceMotion={reduceMotion}
      titleId="splash-title"
      footer={<p className="loading-licence">{LICENCE}</p>}
    />
  );
}

/**
 * Nothing could be loaded. Says what happened and what is safe. Without a server it keeps
 * trying behind this screen. With one, the server has answered that this world cannot be
 * prepared, and only starting another will change that.
 */
export function BootFailure({ message, reduceMotion, closing = false, reachable = false, onRetry }: { message: string; reduceMotion: boolean; closing?: boolean; reachable?: boolean; onRetry?: () => void }) {
  return (
    <LoadingSurface
      mode="boot"
      role="alertdialog"
      failed
      title={reachable ? "This world could not be prepared" : "DSTNS could not start"}
      error={message}
      note={reachable ? (onRetry ? "Nothing has been lost, and the simulator is still running." : "Nothing has been lost, and the simulator is still running. Start a run with a different seed from the DSTNS CLI.") : "Nothing has been lost. This screen clears by itself when the simulator answers."}
      closing={closing}
      reduceMotion={reduceMotion}
      titleId="boot-failure-title"
      actions={
        reachable ? (
          onRetry && (
            <button type="button" className="btn primary" onClick={onRetry}>
              <Icon name="reroll" size={16} />
              Try another city
            </button>
          )
        ) : (
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        )
      }
      footer={<p className="loading-licence">{LICENCE}</p>}
    />
  );
}

/** The session has ended: the server has gone. If it was lost rather than stopped, this clears when it returns. */
export function ShutdownSurface({ reduceMotion, landing, lost = false }: { reduceMotion: boolean; landing?: () => Float32Array | null; lost?: boolean }) {
  return (
    <LoadingSurface
      mode="boot"
      idle
      ending
      landing={landing}
      title={lost ? "Server Unreachable" : "Server Terminated"}
      status={lost ? "This page reconnects if it returns." : "The simulation has ended."}
      // Without the film there is nothing for the words to wait for.
      reduceMotion={reduceMotion || !filmAvailable()}
      titleId="shutdown-title"
      footer={<p className="loading-licence">{LICENCE}</p>}
    />
  );
}

/**
 * Translate what the core reports into a start-up stage.
 *
 * `mapStatus` is the live download report; `lifecycle` and `clientStage` come
 * from the simulation client. Keeping the mapping here means the screen itself
 * has no opinion about the core's vocabulary.
 */
export function splashStageFor(
  mapStatus: {
    active?: boolean;
    city?: string;
    phase?: string;
    bytes?: number;
    total?: number;
    /** What the core's compile is doing: selecting, acquiring or building. */
    preparation?: string;
  } | null,
  lifecycle: string,
  clientStage: string,
  hasTopology: boolean,
  connected = true,
): SplashStage | null {
  if (hasTopology) return null;
  if (!connected) return { step: 0, label: "Starting interface", detail: clientStage || "Connecting to the simulation" };

  // A map is being fetched: the one stage that can report real progress.
  if (mapStatus?.active) {
    const city = mapStatus.city || "the district";
    if (mapStatus.phase === "download") {
      const known = (mapStatus.total ?? 0) > 0;
      return {
        step: 2,
        label: `Downloading ${city}`,
        detail: known
          ? `${formatBytes(mapStatus.bytes ?? 0)} of ${formatBytes(mapStatus.total!)} from OpenStreetMap`
          : `${formatBytes(mapStatus.bytes ?? 0)} from OpenStreetMap`,
        progress: known ? (mapStatus.bytes ?? 0) / mapStatus.total! : undefined,
      };
    }
    if (mapStatus.phase === "parse") return { step: 2, label: `Validating ${city}`, detail: "Checking the downloaded map" };
    return { step: 2, label: `Requesting ${city}`, detail: "Waiting for OpenStreetMap to prepare the extract" };
  }

  // What the core says its compile is doing, whether or not a map is moving.
  const preparation = mapStatus?.preparation ?? "";
  if (preparation === "selecting") return { step: 1, label: "Selecting world", detail: "Resolving the seed to a city district" };
  if (preparation === "acquiring") return { step: 2, label: "Preparing map", detail: "Reading the district's map data" };
  if (preparation === "building") return { step: 3, label: "Generating world", detail: "Building the road graph, signals and schedules" };

  if (lifecycle === "IDLE") return { step: 1, waiting: true, label: "Waiting for a simulation", detail: "Start a run from the DSTNS CLI." };
  if (lifecycle === "PREPARING") return { step: 3, label: "Generating world", detail: "Building the road graph, signals and schedules" };
  if (/network|buildings/i.test(clientStage)) return { step: 4, label: "Initializing simulation", detail: "Receiving roads, places and the first state" };
  return { step: 4, label: "Initializing simulation", detail: clientStage || undefined };
}
