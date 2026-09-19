import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { TUTORIAL_VERSION } from "./tutorialSteps";
import type { UiConfig } from "./uiConfig";

const DONE_KEY = `dstns.tutorial.completed.v${TUTORIAL_VERSION}`;
type Lease = { run: string; revision: number; resume: boolean };

/** A tour owns only the pause it actually performed. Playback guards are
 * checked atomically by the engine, including a same-seed restart. */
export function useTutorial(options: {
  config: UiConfig["tutorial"]; ready: boolean; runId: string;
  suspended: boolean; playbackRevision?: number; blocked: boolean;
  onError: (message: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [phase, setPhase] = useState<"closed" | "starting" | "active" | "finishing">("closed");
  const busy = useRef(false);
  const lease = useRef<Lease | null>(null);
  const generation = useRef(0);
  const attempted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  const start = useCallback(async () => {
    const o = latest.current;
    if (busy.current || !o.config.enabled || !o.ready || o.suspended || o.blocked) return;
    busy.current = true;
    attempted.current = true;
    const ticket = ++generation.current;
    setPhase("starting");
    try {
      const state = await api.status();
      if (state.run_id !== o.runId || !["RUNNING", "PAUSED"].includes(state.data.lifecycle))
        throw new Error("Tutorial needs a running or paused simulation.");
      if (!Number.isSafeInteger(state.data.playback_revision))
        throw new Error("Restart the updated core before using Tutorial.");
      const paused = await api.pause({
        expected_run_id: state.run_id,
        expected_playback_revision: state.data.playback_revision,
        require_asb_normal: true,
      });
      if (!mounted.current || ticket !== generation.current) return;
      lease.current = { run: state.run_id, revision: paused.playback_revision, resume: paused.changed };
      if (latest.current.suspended || !latest.current.config.enabled || latest.current.runId !== state.run_id) {
        lease.current = null;
        busy.current = false;
        setPhase("closed");
        return;
      }
      setPhase("active");
    } catch (error) {
      if (!mounted.current || ticket !== generation.current) return;
      busy.current = false;
      setPhase("closed");
      latest.current.onError(error instanceof Error ? error.message : "Tutorial could not pause the simulation.");
    }
  }, []);

  /**
   * Close the tour. `start` is the final step's action and plays the run
   * whatever its state; otherwise playback resumes only if the tour itself
   * paused it and nothing has changed since.
   */
  const finish = useCallback(async (start = false) => {
    if (!lease.current) return;
    const owned = lease.current;
    lease.current = null;
    try { localStorage.setItem(DONE_KEY, "done"); } catch { /* Session still remembers. */ }
    setPhase("finishing");
    try {
      if (latest.current.runId !== owned.run || latest.current.suspended) return;
      if (start) await api.play({ expected_run_id: owned.run });
      else if (owned.resume)
        await api.play({ expected_run_id: owned.run, expected_playback_revision: owned.revision, require_asb_normal: true });
    } catch {
      if (mounted.current)
        latest.current.onError(
          start
            ? "The simulation could not be started. Use Play to start it."
            : "Tutorial closed. Playback was left unchanged because the runtime state changed.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setPhase("closed");
    }
  }, []);

  useEffect(() => {
    const owned = lease.current;
    const interrupted = options.suspended || !options.config.enabled ||
      (owned && (options.runId !== owned.run || (options.playbackRevision ?? 0) > owned.revision));
    if (interrupted && busy.current && phase !== "finishing") {
      generation.current++;
      lease.current = null;
      busy.current = false;
      setPhase("closed");
      options.onError("Tutorial interrupted by a runtime change. Automatic resume was cancelled.");
    }
  }, [options.suspended, options.config.enabled, options.runId, options.playbackRevision, phase, options.onError]);

  useEffect(() => {
    if (!options.config.show_on_startup || !options.config.enabled || !options.ready || options.blocked || options.suspended || attempted.current) return;
    try { if (localStorage.getItem(DONE_KEY)) return; } catch { /* Storage is optional. */ }
    void start();
  }, [options.config.show_on_startup, options.config.enabled, options.ready, options.blocked, options.suspended, start]);

  return { phase, active: phase === "active", busy: phase !== "closed", start, finish };
}
