// The lightning sound cue: a simple synthesized zap.
//
// Everything is generated with the Web Audio API — there is no audio file.
// One layer only: a CRACK, high-passed white noise (1.6–2.4 kHz) for 60–120 ms
// with a near-instant attack and a very fast decay. A fresh noise buffer is
// generated per play, so two strikes never sound identical.
//
// The master gain is 0.25, so the cue stays quiet, and nothing is scheduled
// past 0.2 s.
//
// The decisions around the sound are pure and unit-tested here; only the
// Web Audio plumbing is imperative. Helpers: pickNewStrikes (which strikes are
// new), takeSoundSlot (the 3 plays/second rate limit), soundAllowed (mute
// rules). playLightningZap is the thin player.

import { socketKey, type LightningStrike } from './lightningLive'

// --- New-strike decision ---------------------------------------------------

// How many strike keys the caller keeps around. A socket strike only lives for
// 3 minutes (SOCKET_DISPLAY_WINDOW_MS), so 500 keys comfortably covers every
// strike that could still be re-sent; the oldest are dropped past that.
export const SEEN_KEY_LIMIT = 500

export interface NewStrikes {
  /** Strikes whose key was not in `seen` yet, in input order, de-duplicated. */
  fresh: LightningStrike[]
  /** The keys to pass as `seen` on the next call (bounded to SEEN_KEY_LIMIT). */
  seenKeys: string[]
}

/**
 * Decides which of `strikes` are new: a strike already in `seen` (and a strike
 * repeated inside this same list) produces no `fresh` entry, so a strike that
 * was already shown never plays the sound again. Identity is socketKey(), the
 * same id + position + kA key the socket window de-duplicates on.
 */
export function pickNewStrikes(
  seen: readonly string[],
  strikes: readonly LightningStrike[],
): NewStrikes {
  const known = new Set(seen)
  const fresh: LightningStrike[] = []
  const keys: string[] = []
  for (const s of strikes) {
    const key = socketKey(s)
    if (known.has(key)) continue
    known.add(key)
    fresh.push(s)
    keys.push(key)
  }
  const all = [...seen, ...keys]
  return { fresh, seenKeys: all.slice(Math.max(0, all.length - SEEN_KEY_LIMIT)) }
}

// --- Rate limit ------------------------------------------------------------

// At most 3 plays per rolling second, so a frame carrying a dozen new strikes
// cannot turn into a burst of noise.
export const SOUND_MAX_PLAYS = 3
export const SOUND_RATE_WINDOW_MS = 1000

export interface SoundSlot {
  /** True when this play is allowed. */
  allowed: boolean
  /** The play timestamps to pass on the next call (old ones already pruned). */
  plays: number[]
}

/**
 * Sliding-window rate limit: keeps the play timestamps inside the last
 * SOUND_RATE_WINDOW_MS, allows the play when fewer than SOUND_MAX_PLAYS are
 * still inside that window, and records the allowed play at `nowMs`.
 * `nowMs` is injected so the rule is testable without waiting.
 */
export function takeSoundSlot(plays: readonly number[], nowMs: number): SoundSlot {
  const recent = plays.filter(t => Number.isFinite(t) && t <= nowMs && nowMs - t < SOUND_RATE_WINDOW_MS)
  if (recent.length >= SOUND_MAX_PLAYS) return { allowed: false, plays: recent }
  return { allowed: true, plays: [...recent, nowMs] }
}

// --- Mute rules ------------------------------------------------------------

export interface SoundGate {
  /** The speaker toggle. Off by default, so nothing plays until it is on. */
  soundOn: boolean
  /** The lightning layer must be on; no layer, no sound. */
  layerOn: boolean
  /** document.hidden: a background tab stays silent. */
  hidden: boolean
}

/** True only when the toggle is on, the layer is on and the tab is visible. */
export function soundAllowed(gate: SoundGate): boolean {
  return gate.soundOn && gate.layerOn && !gate.hidden
}

/**
 * Whether the speaker button is shown at all.
 *
 * The sound cue belongs to the lightning layer, so the button is hidden with
 * it: no layer, no button (a speaker for a layer that is off would be a
 * control over nothing). The user's choice is NOT reset when the layer is
 * switched off — this only decides whether the button is visible.
 */
export function soundButtonVisible(layerOn: boolean): boolean {
  return layerOn
}

// --- Synthesis -------------------------------------------------------------

// Master gain for the whole cue: deliberately quiet.
export const MASTER_GAIN = 0.25
// Nothing in the cue is scheduled past this. The crack is 60–120 ms plus a
// 20 ms stop margin, so 0.2 s is the ceiling.
export const ZAP_TOTAL_S = 0.2
// Length of noise generated per play. Long enough to start each layer at a
// random offset and still run to its scheduled stop.
const NOISE_S = 2

type AudioContextCtor = new () => AudioContext

/**
 * The AudioContext constructor, or null on the server / in old browsers.
 * Exported so a caller can check support without touching a player.
 */
export function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  // `AudioContext` lives on `Window & typeof globalThis`, not on the bare
  // `Window` interface, so the constructor is read off a narrow local shape.
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** A fresh buffer of white noise — new random samples on every play. */
function noiseBuffer(ac: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ac.sampleRate * NOISE_S))
  const buffer = ac.createBuffer(1, length, ac.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

/** A random read offset that still leaves ZAP_TOTAL_S of noise ahead of it. */
function randomOffset(noise: AudioBuffer): number {
  const room = Math.max(0, noise.duration - ZAP_TOTAL_S - 0.05)
  return Math.random() * room
}

/** Schedules the zap crack on `ac` from `t0`. Never throws for gain values. */
function renderZap(ac: AudioContext, noise: AudioBuffer, t0: number) {
  const master = ac.createGain()
  master.gain.value = MASTER_GAIN
  master.connect(ac.destination)

  // Layer 1 — the crack: high-passed noise, 60–120 ms, very fast decay.
  const crackDur = 0.06 + Math.random() * 0.06
  const crack = ac.createBufferSource()
  crack.buffer = noise
  const crackHighpass = ac.createBiquadFilter()
  crackHighpass.type = 'highpass'
  crackHighpass.frequency.value = 1600 + Math.random() * 800
  const crackGain = ac.createGain()
  // exponentialRamp cannot touch 0, hence the 0.0001 floor.
  crackGain.gain.setValueAtTime(0.0001, t0)
  crackGain.gain.exponentialRampToValueAtTime(0.9, t0 + 0.004)
  crackGain.gain.exponentialRampToValueAtTime(0.0001, t0 + crackDur)
  crack.connect(crackHighpass).connect(crackGain).connect(master)
  crack.start(t0, randomOffset(noise))
  crack.stop(t0 + crackDur + 0.02)

}

// One context per page, created lazily on the first play (a context built
// before a user gesture starts suspended in most browsers).
let context: AudioContext | null = null

function sharedContext(Ctor: AudioContextCtor): AudioContext | null {
  try {
    if (!context || context.state === 'closed') context = new Ctor()
    if (context.state === 'suspended') void context.resume()
    return context
  } catch {
    return null
  }
}

/**
 * Plays the cue once. Silent and error-free on the server, when the browser
 * has no AudioContext, and when the context cannot be created or resumed.
 * Muting and rate limiting are the CALLER's job (soundAllowed/takeSoundSlot).
 */
export function playLightningZap(): void {
  const Ctor = audioContextCtor()
  if (!Ctor) return
  const ac = sharedContext(Ctor)
  if (!ac) return
  try {
    renderZap(ac, noiseBuffer(ac), ac.currentTime + 0.01)
  } catch {
    // No sound, no error: a failing cue must never break the map.
  }
}
