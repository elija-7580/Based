// BSD-447: Wiedergabe für Video- und Audio-Blöcke mit Based-Bedienung statt der Browser-Steuerleiste (System-Element,
// in WebKit und Chromium verschieden, mit eigenem „⋮“-Menü). Leiste: Abspielen/Pause (BasedIconButton), Zeit in
// --font-mono, Fortschritt als Astryx-Slider, Ton aus/an, bei Video Vollbild. Tastatur auf dem Player: Leertaste/K
// spielt oder hält an, ←/→ springen 5 s, M schaltet den Ton, F Vollbild. Aussehen nur aus Tokens (media.css).
import { HStack } from "@astryxdesign/core/Layout";
import { Slider } from "@astryxdesign/core/Slider";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BasedIconButton } from "./index.js";
import { EXPAND, Glyph, MUTED, PAUSE, PLAY, SOUND } from "./mediaIcons.js";
import "./media.css";

/** „1:05“, „12:00“, „1:02:03“; unbekannte Dauer „–:––“. */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Was eine Taste auf dem Player tut (rein, getestet). */
export function mediaKeyAction(key: string, kind: "video" | "audio"): "toggle" | "back" | "forward" | "mute" | "fullscreen" | undefined {
  switch (key) {
    case " ": case "k": case "K": return "toggle";
    case "ArrowLeft": return "back";
    case "ArrowRight": return "forward";
    case "m": case "M": return "mute";
    case "f": case "F": return kind === "video" ? "fullscreen" : undefined;
    default: return undefined;
  }
}

export const MEDIA_SEEK_STEP = 5;

export interface BasedMediaPlayerProps {
  src: string;
  kind: "video" | "audio";
  /** Name für Screenreader (Dateiname). */
  label: string;
  testID?: string;
}

export function BasedMediaPlayer({ src, kind, label, testID }: BasedMediaPlayerProps) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const [muted, setMuted] = useState(false);

  const sync = useCallback(() => {
    const m = media.current;
    if (!m) return;
    setPlaying(!m.paused && !m.ended);
    setTime(m.currentTime);
    setDuration(m.duration);
    setMuted(m.muted);
  }, []);
  useEffect(sync, [src, sync]);

  const toggle = () => {
    const m = media.current;
    if (!m) return;
    if (m.paused || m.ended) void m.play().catch(() => undefined);
    else m.pause();
  };
  const seek = (t: number) => {
    const m = media.current;
    if (!m || !Number.isFinite(m.duration)) return;
    m.currentTime = Math.max(0, Math.min(m.duration, t));
    setTime(m.currentTime);
  };
  const mute = () => { if (media.current) media.current.muted = !media.current.muted; };
  const fullscreen = () => { void media.current?.requestFullscreen?.().catch(() => undefined); };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Knöpfe und Regler behalten ihre eigenen Tasten (Leertaste drückt den Knopf, Pfeile bewegen den Regler)
    const t = e.target as HTMLElement;
    if (t !== root.current && t !== media.current) return;
    const a = mediaKeyAction(e.key, kind);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (a === "toggle") toggle();
    else if (a === "back") seek(time - MEDIA_SEEK_STEP);
    else if (a === "forward") seek(time + MEDIA_SEEK_STEP);
    else if (a === "mute") mute();
    else fullscreen();
  };

  const events = { onPlay: sync, onPause: sync, onEnded: sync, onTimeUpdate: sync, onLoadedMetadata: sync, onDurationChange: sync, onVolumeChange: sync };
  const known = Number.isFinite(duration) && duration > 0;
  return (
    <div ref={root} className="based-media" data-kind={kind} data-playing={playing ? "" : undefined} tabIndex={0} role="group" aria-label={label}
      onKeyDown={onKeyDown} {...(testID ? { "data-testid": testID } : {})}>
      {kind === "video"
        ? <video ref={media} className="based-media-el" src={src} preload="metadata" playsInline onClick={toggle} {...events} />
        : <audio ref={media} className="based-media-el" src={src} preload="metadata" {...events} />}
      <HStack gap={2} vAlign="center" className="based-media-bar">
        <BasedIconButton label={playing ? "Pause" : "Play"} tooltip={playing ? "Pause (Space)" : "Play (Space)"} icon={<Glyph d={playing ? PAUSE : PLAY} filled={!playing} />} onClick={toggle} testID="media-play" />
        <span className="based-media-time" data-testid="media-time">{formatMediaTime(time)} / {formatMediaTime(duration)}</span>
        <span className="based-media-seek">
          <Slider label="Position" isLabelHidden valueDisplay="none" width="100%" min={0} max={known ? duration : 1} step={0.1}
            value={known ? Math.min(time, duration) : 0} isDisabled={!known} formatValue={formatMediaTime} onChange={(v: number) => seek(v)} />
        </span>
        <BasedIconButton label={muted ? "Unmute" : "Mute"} tooltip={muted ? "Unmute (M)" : "Mute (M)"} pressed={muted} icon={<Glyph d={muted ? MUTED : SOUND} />} onClick={mute} testID="media-mute" />
        {kind === "video" ? <BasedIconButton label="Full screen" tooltip="Full screen (F)" icon={<Glyph d={EXPAND} />} onClick={fullscreen} testID="media-fullscreen" /> : null}
      </HStack>
    </div>
  );
}
