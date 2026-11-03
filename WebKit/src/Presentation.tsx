// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

/**
 * The film's music, and its full screen, when the operator has turned them on.
 *
 * The music is written here, not recorded: slow pads through four chords in D, a sub bass under them, and a
 * pentatonic line that thickens as it goes, played by the browser as it goes. It's original, so there is
 * nothing to license, and nothing to download. The same seed makes it the same every time.
 */

const BPM = 76;
const EIGHTH = 30 / BPM;
/** Each chord holds two bars: Dadd9, Bm7, Gmaj7, A. Lowest note first. */
const CHORDS = [
  [38, 57, 62, 64, 69],
  [35, 54, 59, 62, 66],
  [31, 55, 59, 62, 66],
  [33, 52, 57, 61, 64],
];
const LINE = [62, 64, 66, 69, 71, 74, 76, 78, 81];
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
  master.connect(audio.destination);
  const bus = audio.createGain();
  bus.gain.value = 0.7;
  bus.connect(master);
  // A large, dark room: decaying noise as the room's answer to a click.
  const room = audio.createConvolver();
  const length = Math.floor(audio.sampleRate * 4);
  const impulse = audio.createBuffer(2, length, audio.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
  }
  room.buffer = impulse;
  const wet = audio.createGain();
  wet.gain.value = 0.55;
  bus.connect(room).connect(wet).connect(master);
  // The line echoes a dotted eighth behind itself, darker each time.
  const echo = audio.createDelay(2);
  echo.delayTime.value = EIGHTH * 1.5;
  const feedback = audio.createGain();
  feedback.gain.value = 0.38;
  const tone = audio.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 2400;
  echo.connect(tone).connect(feedback).connect(echo);
  tone.connect(bus);

  let seed = 20260;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const pad = (notes: number[], at: number, hold: number) => {
    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(500, at);
    filter.frequency.linearRampToValueAtTime(1300, at + hold * 0.6);
    filter.frequency.linearRampToValueAtTime(700, at + hold + 3);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.045, at + 2.6);
    gain.gain.setValueAtTime(0.045, at + hold);
    gain.gain.linearRampToValueAtTime(0, at + hold + 3.2);
    filter.connect(gain).connect(bus);
    for (const note of notes) {
      for (const detune of [-7, 7]) {
        const voice = audio.createOscillator();
        voice.type = "sawtooth";
        voice.frequency.value = hz(note);
        voice.detune.value = detune;
        voice.connect(filter);
        voice.start(at);
        voice.stop(at + hold + 3.4);
      }
    }
  };
  const bass = (note: number, at: number, hold: number) => {
    const voice = audio.createOscillator();
    voice.type = "sine";
    voice.frequency.value = hz(note);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.22, at + 1.2);
    gain.gain.setValueAtTime(0.22, at + hold - 0.4);
    gain.gain.linearRampToValueAtTime(0, at + hold + 0.8);
    voice.connect(gain).connect(bus);
    voice.start(at);
    voice.stop(at + hold + 1);
  };
  const pluck = (note: number, at: number, loud: number) => {
    const voice = audio.createOscillator();
    voice.type = "triangle";
    voice.frequency.value = hz(note);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(loud, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.4);
    voice.connect(gain);
    gain.connect(bus);
    gain.connect(echo);
    voice.start(at);
    voice.stop(at + 1.5);
  };

  // Scheduled a little ahead on the audio clock, so that a busy page never makes it stumble.
  let step = 0;
  let next = audio.currentTime + 0.1;
  let place = 2;
  const schedule = () => {
    while (next < audio.currentTime + 0.8) {
      const bar = Math.floor(step / 8);
      if (step % 16 === 0) {
        const chord = CHORDS[(step / 16) % CHORDS.length];
        pad(chord.slice(1), next, EIGHTH * 16);
        if (bar >= 4) bass(chord[0], next, EIGHTH * 16);
      }
      // Two bars of pads alone, then the line comes in and fills out over the next sixteen.
      const density = bar < 2 ? 0 : Math.min(0.62, 0.18 + (bar - 2) * 0.03);
      const strong = step % 4 === 0;
      if (density > 0 && random() < (strong ? density + 0.2 : density)) {
        place = Math.max(0, Math.min(LINE.length - 1, place + Math.round((random() - 0.5) * 4)));
        pluck(LINE[place], next, strong ? 0.07 : 0.045);
        // Now and then, a bell two octaves up.
        if (bar >= 8 && random() < 0.08) pluck(LINE[place] + 24, next + EIGHTH * 0.5, 0.018);
      }
      step = (step + 1) % (16 * CHORDS.length * 8);
      next += EIGHTH;
    }
  };
  schedule();
  const timer = setInterval(schedule, 200);

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
  music.level(volume, 4);
  return music;
}

const MUTED_KEY = "dstns.music.muted";

/**
 * Plays the music while `playing`, and fades it out when that ends. Shows a small mute button while it plays.
 * A browser that won't play sound before a person has touched the page starts it at their first touch.
 */
export function MusicControl({ playing, volume }: { playing: boolean; volume: number }) {
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
    const started = startMusic(mutedRef.current ? 0 : volume);
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
  }, [playing, volume]);

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
