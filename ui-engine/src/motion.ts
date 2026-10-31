// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

/**
 * One physical model for every moving thing.
 *
 * Motion is a damped harmonic oscillator, so it is defined by stiffness and
 * damping rather than a duration and a curve. CSS transitions sample the same
 * solution through linear() tokens; anything that must keep its velocity when
 * interrupted (the settings drawer, the map camera) runs the spring directly.
 *
 * Spatial springs move position, size and shape, and may overshoot a little.
 * Effects springs change opacity, colour, blur and shadow, and are critically
 * damped because those cannot overshoot.
 */

export interface SpringPreset {
  /** Stiffness, with unit mass. */
  k: number;
  /** Damping. */
  c: number;
}

export const SPRINGS = {
  spatialFast: { k: 800, c: 52 },
  spatialDefault: { k: 420, c: 38 },
  spatialSlow: { k: 220, c: 28 },
  effectsFast: { k: 900, c: 60 },
  effectsDefault: { k: 400, c: 40 },
  effectsSlow: { k: 196, c: 28 },
  /** Direct manipulation: a press, a thumb. Overshoots under 5%, so it reads as a response, not a bounce. */
  lively: { k: 420, c: 30 },
  /** The map's camera: a long, heavy move that never overshoots the place it is showing. */
  camera: { k: 42, c: 13 },
  /** A wheel or button zoom, which must track the input closely. */
  cameraZoom: { k: 260, c: 32.2 },
} as const satisfies Record<string, SpringPreset>;

export type SpringName = keyof typeof SPRINGS;

/** Position of a spring from 0 towards 1 at time `t` seconds, starting at rest. */
export function springProgress({ k, c }: SpringPreset, t: number): number {
  const w0 = Math.sqrt(k);
  const zeta = c / (2 * w0);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const root = w0 * Math.sqrt(zeta * zeta - 1);
  const a = -zeta * w0 + root;
  const b = -zeta * w0 - root;
  return 1 - (b * Math.exp(a * t) - a * Math.exp(b * t)) / (b - a);
}

/** Seconds until a spring stays within `tolerance` of its target. */
export function settleTime(preset: SpringPreset, tolerance = 0.005): number {
  const dt = 1 / 240;
  let last = 0;
  for (let t = 0; t < 10; t += dt) if (Math.abs(1 - springProgress(preset, t)) > tolerance) last = t;
  return last + dt;
}

/** The spring as a CSS easing, for a transition of its settle time. */
export function springEasing(preset: SpringPreset, samples = 40): string {
  const duration = settleTime(preset);
  const points: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const value = i === samples ? 1 : springProgress(preset, (i / samples) * duration);
    points.push(String(+value.toFixed(4)));
  }
  return `linear(${points.join(", ")})`;
}

const durationMs = (name: SpringName) => Math.round(settleTime(SPRINGS[name]) * 1000);

/**
 * Exit times for surfaces that must stay mounted while they leave, derived from
 * the same springs as the CSS that moves them, so the two cannot drift apart.
 */
export const MOTION_MS = {
  overlay: durationMs("spatialDefault"),
  boot: durationMs("effectsSlow") + 120,
};

/** Publish the springs as CSS tokens, and route the older easing tokens through them. */
export function installMotionTokens(root: HTMLElement = document.documentElement): void {
  if (typeof CSS === "undefined" || !CSS.supports?.("transition-timing-function", "linear(0, 1)")) return;
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  for (const name of Object.keys(SPRINGS) as SpringName[]) {
    set(`--spring-${name}`, springEasing(SPRINGS[name]));
    set(`--spring-${name}-ms`, `${durationMs(name)}ms`);
  }
  set("--ease", "var(--spring-spatialDefault)");
  set("--ease-out", "var(--spring-spatialDefault)");
  set("--ease-snap", "var(--spring-spatialFast)");
  set("--spring", "var(--spring-lively)");
  set("--t-fast", "var(--spring-effectsFast-ms)");
  set("--t-hover", "var(--spring-effectsFast-ms)");
  set("--t-pick", "var(--spring-spatialFast-ms)");
  set("--t-select", "var(--spring-spatialFast-ms)");
  set("--t-pop", "var(--spring-spatialDefault-ms)");
  set("--t-panel", "var(--spring-spatialDefault-ms)");
  set("--t-morph", "var(--spring-spatialDefault-ms)");
  set("--t-expand", "var(--spring-spatialSlow-ms)");
}

// ---------------------------------------------------------------------------
// Running springs. One frame loop, which stops itself when nothing is moving.
// ---------------------------------------------------------------------------

type Step = (dt: number) => boolean;
const steps = new Set<Step>();
let frame = 0;
let previous = 0;

function tick(now: number) {
  // A background tab may not paint for seconds; do not leap on its return.
  const dt = Math.min(1 / 20, Math.max(0, (now - previous) / 1000));
  previous = now;
  for (const step of [...steps]) if (!step(dt)) steps.delete(step);
  frame = steps.size ? requestAnimationFrame(tick) : 0;
}

/** Run `step` every frame until it returns false. Returns a cancel function. */
export function animate(step: Step): () => void {
  steps.add(step);
  if (!frame) {
    previous = performance.now();
    frame = requestAnimationFrame(tick);
  }
  return () => {
    steps.delete(step);
  };
}

/** Advance position and velocity by `dt`. Sub-stepped, so stiff springs stay stable. */
export function stepSpring(x: number, v: number, target: number, { k, c }: SpringPreset, dt: number): [number, number] {
  const count = Math.max(1, Math.ceil(dt / (1 / 480)));
  const h = dt / count;
  for (let i = 0; i < count; i++) {
    v += (-k * (x - target) - c * v) * h;
    x += v * h;
  }
  return [x, v];
}

/**
 * A value on a spring. Retargeting keeps the current velocity, so an interrupted
 * movement turns around rather than stopping and starting again.
 */
export class Spring {
  value: number;
  velocity = 0;
  private target: number;
  private cancel: (() => void) | null = null;

  constructor(
    initial: number,
    private preset: SpringPreset,
    private onChange: (value: number) => void,
    private epsilon = 0.01,
  ) {
    this.value = this.target = initial;
  }

  set(target: number, velocity?: number): void {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    this.cancel ??= animate((dt) => {
      [this.value, this.velocity] = stepSpring(this.value, this.velocity, this.target, this.preset, dt);
      const done = Math.abs(this.value - this.target) < this.epsilon && Math.abs(this.velocity) < this.epsilon * 10;
      if (done) {
        this.value = this.target;
        this.velocity = 0;
        this.cancel = null;
      }
      this.onChange(this.value);
      return !done;
    });
  }

  /** Go there now, with no movement: reduced motion, or a drag following the pointer. */
  jump(value: number): void {
    this.stop();
    this.value = this.target = value;
    this.velocity = 0;
    this.onChange(value);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }
}
