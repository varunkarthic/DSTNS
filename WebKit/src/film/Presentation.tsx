// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icons";

/**
 * The film's music, and its full screen, when the operator has turned them on.
 *
 * The music is written here, not recorded, and played by the browser as it goes: an original theme in the manner of a
 * cinematic hero's score. Strings drive in sixteenths under timpani, brass answers on the off-beats, and a horn line
 * of its own soars over the top, in D minor, through Dm, B♭, F and C. It builds over four phrases, breaks down to the
 * strings, and builds again. It is original, so there is nothing to license, and nothing to download; the same seed
 * makes it the same every time.
 */

const BPM = 118;
const SIXTEENTH = 15 / BPM;
const BAR = 16;
/** Two bars each: the chord's root (bass), then its voicing. */
const CHORDS: readonly (readonly number[])[] = [
  [38, 57, 62, 65],
  [34, 58, 62, 65],
  [41, 57, 60, 65],
  [36, 55, 60, 64],
];
/** The horn's theme, eight bars long: [sixteenth in the bar, note, length in sixteenths]. */
const THEME: readonly (readonly (readonly [number, number, number])[])[] = [
  [[0, 62, 4], [4, 69, 6], [10, 67, 2], [12, 65, 4]],
  [[0, 64, 8], [8, 60, 4], [12, 62, 4]],
  [[0, 65, 4], [4, 67, 4], [8, 69, 4], [12, 72, 4]],
  [[0, 70, 12], [12, 69, 4]],
  [[0, 69, 4], [4, 65, 4], [8, 72, 6], [14, 70, 2]],
  [[0, 69, 8], [8, 67, 4], [12, 65, 4]],
  [[0, 67, 4], [4, 64, 4], [8, 67, 4], [12, 72, 4]],
  [[0, 69, 12], [12, 64, 4]],
];
/** Phrases of eight bars: what plays in each, in a cycle of six. */
const ARRANGEMENT = [
  { strings: true, drums: 1, brass: false, horn: 0 },
  { strings: true, drums: 2, brass: true, horn: 0 },
  { strings: true, drums: 2, brass: true, horn: 1 },
  { strings: true, drums: 3, brass: true, horn: 2 },
  { strings: true, drums: 0, brass: false, horn: 0 },
  { strings: true, drums: 3, brass: true, horn: 2 },
];
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export interface Music {
  /** Brings the level to `level` over `seconds`. */
  level(level: number, seconds?: number): void;
  /** Fades out over `seconds`, then lets everything go. */
  stop(seconds?: number): void;
  /** Whether the browser has let it start yet: before a person has touched the page, it may not. */
  running(): boolean;
  resume(): void;
}

export function startMusic(volume: number): Music | null {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  const audio = new Context();
  const master = audio.createGain();
  master.gain.value = 0;
  // Nothing ever clips, however much plays at once.
  const limiter = audio.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.ratio.value = 6;
  limiter.connect(master).connect(audio.destination);
  const bus = audio.createGain();
  bus.gain.value = 0.6;
  bus.connect(limiter);
  // A hall: decaying noise as the room's answer to a click.
  const room = audio.createConvolver();
  const length = Math.floor(audio.sampleRate * 3.2);
  const impulse = audio.createBuffer(2, length, audio.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6;
  }
  room.buffer = impulse;
  const hall = audio.createGain();
  hall.gain.value = 0.35;
  hall.connect(room).connect(limiter);
  const noise = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
  const grain = noise.getChannelData(0);
  for (let i = 0; i < grain.length; i++) grain[i] = Math.random() * 2 - 1;

  // A sound: oscillators through a filter and an envelope, to the bus and some to the hall.
  const voice = (at: number, notes: readonly number[], shape: OscillatorType, peak: number, attack: number, hold: number, release: number, cutoff: [number, number], wet: number, detune = 0) => {
    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoff[0], at);
    filter.frequency.linearRampToValueAtTime(cutoff[1], at + attack + hold * 0.5);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.setValueAtTime(peak, at + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
    filter.connect(gain);
    gain.connect(bus);
    if (wet > 0) {
      const send = audio.createGain();
      send.gain.value = wet;
      gain.connect(send).connect(hall);
    }
    for (const note of notes) {
      for (const cents of detune ? [-detune, detune] : [0]) {
        const osc = audio.createOscillator();
        osc.type = shape;
        osc.frequency.value = hz(note);
        osc.detune.value = cents;
        osc.connect(filter);
        osc.start(at);
        osc.stop(at + attack + hold + release + 0.05);
      }
    }
  };
  const timpani = (at: number, pitch: number, loud: number) => {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(pitch * 1.9, at);
    osc.frequency.exponentialRampToValueAtTime(pitch, at + 0.12);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(loud, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
    osc.connect(gain);
    gain.connect(bus);
    gain.connect(hall);
    osc.start(at);
    osc.stop(at + 1);
  };
  const hit = (at: number, from: number, loud: number, decay: number) => {
    const source = audio.createBufferSource();
    source.buffer = noise;
    const filter = audio.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = from;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(loud, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    source.connect(filter).connect(gain);
    gain.connect(bus);
    gain.connect(hall);
    source.start(at, Math.random() * 0.5, decay + 0.05);
  };

  // Scheduled a little ahead on the audio clock, so that a busy page never makes it stumble.
  let step = 0;
  let next = audio.currentTime + 0.12;
  const schedule = () => {
    while (next < audio.currentTime + 0.6) {
      const bar = Math.floor(step / BAR);
      const inBar = step % BAR;
      const phrase = Math.floor(bar / 8);
      const part = ARRANGEMENT[phrase % ARRANGEMENT.length];
      const chord = CHORDS[Math.floor((bar % 8) / 2)];
      const root = chord[0];
      // Strings: sixteenths on the root, rising to its fifth and octave, the first of each beat leaned on.
      if (part.strings) {
        const pattern = [0, 0, 12, 0, 7, 0, 12, 7];
        const note = root + 24 + pattern[inBar % 8];
        voice(next, [note], "sawtooth", inBar % 4 === 0 ? 0.05 : 0.03, 0.004, 0.02, 0.09, [700, 1500], 0.15);
      }
      // The bass, on every eighth.
      if (part.drums > 0 && inBar % 2 === 0) voice(next, [root], "sawtooth", 0.08, 0.005, 0.08, 0.12, [220, 380], 0);
      // Timpani on one and three, a roll into every fourth bar, the snare on two and four.
      if (part.drums > 0 && (inBar === 0 || inBar === 8)) timpani(next, hz(root + 12), 0.5);
      if (part.drums > 1 && bar % 4 === 3 && inBar >= 12) timpani(next, hz(root + 12), 0.25 + (inBar - 12) * 0.06);
      if (part.drums > 1 && (inBar === 4 || inBar === 12)) hit(next, 1800, 0.14, 0.2);
      if (part.drums > 2 && inBar % 2 === 1) hit(next, 7000, 0.03, 0.05);
      // Brass: a stab on the downbeat, and an answer off the beat.
      if (part.brass && (inBar === 0 || inBar === 10) && bar % 2 === 0) voice(next, chord.slice(1), "sawtooth", 0.035, 0.03, 0.18, 0.5, [500, 2600], 0.4, 6);
      // A held pad under it all, softly, once the brass has come in.
      if (part.brass && inBar === 0 && bar % 2 === 0) voice(next, chord.slice(1).map((n) => n - 12), "sawtooth", 0.012, 0.6, SIXTEENTH * 28, 1.2, [400, 900], 0.6, 9);
      // The horn: the theme, and in the biggest phrases the same an octave up beside it.
      if (part.horn > 0) {
        for (const [at, note, held] of THEME[bar % 8]) {
          if (at !== inBar) continue;
          const time = SIXTEENTH * held;
          voice(next, part.horn > 1 ? [note, note + 12] : [note], "sawtooth", part.horn > 1 ? 0.04 : 0.05, 0.06, time * 0.8, 0.45, [900, 2200], 0.5, 5);
        }
      }
      step = (step + 1) % (BAR * 8 * ARRANGEMENT.length);
      next += SIXTEENTH;
    }
  };
  schedule();
  const timer = setInterval(schedule, 150);

  const music: Music = {
    level(level, seconds = 1.5) {
      master.gain.cancelScheduledValues(audio.currentTime);
      master.gain.setValueAtTime(master.gain.value, audio.currentTime);
      master.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, level)), audio.currentTime + seconds);
    },
    stop(seconds = 2.5) {
      music.level(0, seconds);
      setTimeout(() => {
        clearInterval(timer);
        void audio.close().catch(() => undefined);
      }, seconds * 1000 + 100);
    },
    running: () => audio.state === "running",
    resume() {
      void audio.resume().catch(() => undefined);
    },
  };
  music.level(volume, 3);
  return music;
}

/**
 * A file of the operator's own (MP3, M4A or WAV, which the server serves at one address), looped, through the same
 * level and fades as the written score. If it can't be played, the score plays instead.
 */
export function startTrack(url: string, volume: number, fallback: () => Music | null): Music | null {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  const audio = new Context();
  const element = new Audio();
  element.src = url;
  element.loop = true;
  element.preload = "auto";
  const source = audio.createMediaElementSource(element);
  const master = audio.createGain();
  master.gain.value = 0;
  source.connect(master).connect(audio.destination);
  let replaced: Music | null = null;
  let stopped = false;
  element.addEventListener("error", () => {
    // Not a file this browser can play after all: the written score instead.
    if (stopped || replaced) return;
    void audio.close().catch(() => undefined);
    replaced = fallback();
  }, { once: true });
  const play = () => void element.play().catch(() => undefined);
  play();
  const music: Music = {
    level(level, seconds = 1.5) {
      if (replaced) return replaced.level(level, seconds);
      master.gain.cancelScheduledValues(audio.currentTime);
      master.gain.setValueAtTime(master.gain.value, audio.currentTime);
      master.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, level)), audio.currentTime + seconds);
    },
    stop(seconds = 2.5) {
      stopped = true;
      if (replaced) return replaced.stop(seconds);
      music.level(0, seconds);
      setTimeout(() => {
        element.pause();
        element.removeAttribute("src");
        void audio.close().catch(() => undefined);
      }, seconds * 1000 + 100);
    },
    running: () => (replaced ? replaced.running() : audio.state === "running" && !element.paused),
    resume() {
      if (replaced) return replaced.resume();
      void audio.resume().catch(() => undefined);
      if (element.paused) play();
    },
  };
  music.level(volume, 3);
  return music;
}

const MUTED_KEY = "dstns.music.muted";

/**
 * Plays the music while `playing`, and fades it out when that ends. Shows a small mute button while it plays.
 * A browser that won't play sound before a person has touched the page starts it at their first touch.
 */
export function MusicControl({ playing, volume, track = false }: { playing: boolean; volume: number; /** The server has a file of the operator's own to play. */ track?: boolean }) {
  const music = useRef<Music | null>(null);
  const [on, setOn] = useState(false);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    if (!playing) return;
    const level = mutedRef.current ? 0 : volume;
    const started = track ? startTrack("/api/v1/system/music", level, () => startMusic(mutedRef.current ? 0 : volume)) : startMusic(level);
    if (!started) return;
    music.current = started;
    setOn(true);
    const wake = () => started.resume();
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      started.stop();
      music.current = null;
      setOn(false);
    };
  }, [playing, volume, track]);

  const toggle = () => {
    const quiet = !muted;
    setMuted(quiet);
    try {
      localStorage.setItem(MUTED_KEY, quiet ? "1" : "0");
    } catch {
      // A private window keeps the choice for this page only.
    }
    music.current?.resume();
    music.current?.level(quiet ? 0 : volume, 0.6);
  };

  if (!on) return null;
  return (
    <button type="button" className="music-toggle" onClick={toggle} aria-pressed={muted} aria-label={muted ? "Play music" : "Mute music"} title={muted ? "Play music" : "Mute music"}>
      <Icon name={muted ? "soundOff" : "sound"} size={14} />
    </button>
  );
}

/** Full screen from the first touch, when the operator asked for it: a browser won't allow it any earlier. */
export function useFullscreen(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const go = () => {
      if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => undefined);
    };
    window.addEventListener("pointerdown", go, { once: true });
    window.addEventListener("keydown", go, { once: true });
    return () => {
      window.removeEventListener("pointerdown", go);
      window.removeEventListener("keydown", go);
    };
  }, [enabled]);
}
