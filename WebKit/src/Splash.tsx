// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useState } from "react";
import { LoadingSurface } from "./LoadingSurface";
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

/** True of every run, to read during a wait. The last one is an invitation. */
export const BOOT_FACTS = [
  "The same seed gives the same day, second by second, on any machine.",
  "Physics runs in fixed one-second steps, whatever the playback speed.",
  "Each seed picks a real district from one of 181 cities, mapped by OpenStreetMap.",
  "A downloaded city is kept, so its next district starts without waiting.",
  "Light mode, colour vision palettes and reduced motion are in Settings.",
  "Move the pointer across the network, or click it: the streets are on springs.",
];

const LICENCE = "Deterministic Spatiotemporal Transport Network Simulator · © 2026 Varun Karthic · AGPL-3.0-or-later · Map data © OpenStreetMap contributors (ODbL)";

export function Splash({
  stage,
  reduceMotion,
  closing = false,
  onDismiss,
}: {
  stage: SplashStage;
  reduceMotion: boolean;
  closing?: boolean;
  onDismiss?: () => void;
}) {
  // Only offer a way past the start-up screen once waiting has become
  // notable, so the option does not flash up during a fast start.
  const [stalled, setStalled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [fact, setFact] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), 12000);
    const started = performance.now();
    const clock = setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    const facts = setInterval(() => setFact((n) => (n + 1) % BOOT_FACTS.length), 6500);
    return () => {
      clearTimeout(timer);
      clearInterval(clock);
      clearInterval(facts);
    };
  }, []);

  return (
    <LoadingSurface
      mode="boot"
      eyebrow={stage.waiting ? "Welcome to DSTNS" : undefined}
      title={stage.label}
      status={stage.waiting || elapsed < 3 ? stage.detail : `${stage.detail ?? "Working"} · ${elapsed} s`}
      aside={
        <p className="boot-fact" key={fact}>
          {BOOT_FACTS[fact]}
        </p>
      }
      steps={stage.waiting ? undefined : BOOT_STEPS}
      stepIndex={stage.step}
      progress={stage.progress}
      progressLabel={stage.label}
      idle={stage.waiting}
      closing={closing}
      reduceMotion={reduceMotion}
      titleId="splash-title"
      actions={
        stalled && onDismiss && !closing && !stage.waiting ? (
          <button type="button" className="btn ghost" onClick={onDismiss}>
            Continue without waiting
          </button>
        ) : undefined
      }
      footer={<p className="loading-licence">{LICENCE}</p>}
    />
  );
}

/** Nothing could be loaded. Says what happened and what is safe, and keeps trying behind it. */
export function BootFailure({ message, reduceMotion, closing = false }: { message: string; reduceMotion: boolean; closing?: boolean }) {
  return (
    <LoadingSurface
      mode="boot"
      role="alertdialog"
      failed
      title="DSTNS could not start"
      error={message}
      note="Nothing has been lost. This screen clears by itself as soon as the simulator answers."
      closing={closing}
      reduceMotion={reduceMotion}
      titleId="boot-failure-title"
      actions={
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      }
      footer={<p className="loading-licence">{LICENCE}</p>}
    />
  );
}

/** The session was terminated: the server has gone, and nothing here will come back. */
export function ShutdownSurface({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <LoadingSurface
      mode="boot"
      idle
      title="DSTNS has shut down"
      status="The simulation and its server have stopped. Start a new run from the DSTNS CLI."
      reduceMotion={reduceMotion}
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
    const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
    if (mapStatus.phase === "download") {
      const known = (mapStatus.total ?? 0) > 0;
      return {
        step: 2,
        label: `Downloading ${city}`,
        detail: known
          ? `${mib(mapStatus.bytes ?? 0)} of ${mib(mapStatus.total!)} MiB from OpenStreetMap`
          : `${mib(mapStatus.bytes ?? 0)} MiB from OpenStreetMap`,
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
