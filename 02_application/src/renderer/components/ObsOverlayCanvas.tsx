import { useEffect, useState, type CSSProperties } from "react";
import type { AppLanguage, OverlayPosition } from "../../domain/entities/app-settings.js";
import protossModelUrl from "../assets/protoss-model.png";
import randomModelUrl from "../assets/random-model.png";
import terranModelUrl from "../assets/terran-model.png";
import zergModelUrl from "../assets/zerg-model.png";
import { isSmartSnapshot, SmartOverlayLayer, type SmartOverlaySnapshot } from "./SmartOverlayLayer.js";

export type ObsOpponent = {
  readonly nickname: string;
  readonly race: string;
  readonly mmr?: number | null;
  readonly league?: string | null;
  readonly encounters?: number | null;
  readonly wins?: number | null;
  readonly losses?: number | null;
  readonly totalGames?: number | null;
};

export type ObsOverlayState = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly language: AppLanguage;
  readonly width: number;
  readonly height: number;
  readonly position: OverlayPosition;
  readonly opponent?: ObsOpponent | null;
  readonly smart?: SmartOverlaySnapshot;
};

const STALE_MS = 5000;
const positions = new Set(["top-left", "top-center", "top-right", "middle-left", "middle-right", ...Array.from({ length: 6 }, (_, i) => `bottom-${i + 1}`)]);
const portraits: Record<string, string> = { Terran: terranModelUrl, Zerg: zergModelUrl, Protoss: protossModelUrl, Random: randomModelUrl };
const labels = {
  ru: { opponent: "Соперник текущего матча", encounters: "Встречи", overlay: "Оверлей трансляции" },
  en: { opponent: "Current match opponent", encounters: "Meetings", overlay: "Stream overlay" }
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Reject malformed snapshots; the browser never guesses identities or missing numbers. */
export function parseObsOverlayState(value: unknown): ObsOverlayState | null {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.generatedAt !== "string"
    || !Number.isFinite(Date.parse(value.generatedAt)) || typeof value.enabled !== "boolean" || typeof value.active !== "boolean"
    || (value.language !== "ru" && value.language !== "en")
    || !finiteInRange(value.width, 640, 7680) || !Number.isInteger(value.width)
    || !finiteInRange(value.height, 360, 4320) || !Number.isInteger(value.height)
    || typeof value.position !== "string" || !positions.has(value.position)) return null;
  if (value.smart !== undefined && !isSmartSnapshot(value.smart)) return null;
  if (value.opponent !== undefined && value.opponent !== null) {
    if (!record(value.opponent) || typeof value.opponent.nickname !== "string" || !value.opponent.nickname.trim()
      || value.opponent.nickname.length > 128 || typeof value.opponent.race !== "string" || value.opponent.race.length > 32
      || (value.opponent.league !== undefined && value.opponent.league !== null
        && (typeof value.opponent.league !== "string" || value.opponent.league.length > 64))) return null;
    for (const key of ["mmr", "encounters", "wins", "losses", "totalGames"]) {
      const stat = value.opponent[key];
      if (stat !== undefined && stat !== null && !finiteInRange(stat, 0, Number.MAX_SAFE_INTEGER)) return null;
    }
  }
  if (value.active && (!value.opponent || !record(value.opponent))) return null;
  return value as ObsOverlayState;
}

export function visibleObsState(state: ObsOverlayState | null, receivedAt: number, now: number, wallNow = Date.now()): state is ObsOverlayState & { opponent: ObsOpponent } {
  return Boolean(state?.enabled && state.active && state.opponent && receivedAt >= 0 && now - receivedAt <= STALE_MS
    && wallNow - Date.parse(state.generatedAt) <= STALE_MS && Date.parse(state.generatedAt) - wallNow <= STALE_MS);
}

export function retainSmartLoading(state: ObsOverlayState | null): boolean {
  return Boolean(state?.smart?.enabled && state.smart.loadingEnabled !== false && state.smart.phase === "loading" && state.smart.mode.enabled);
}
/** Uncertain detection cannot expose a loading screen that was already covered. */
export function mergeSmartSnapshot(previous: ObsOverlayState | null, next: ObsOverlayState): ObsOverlayState {
  return retainSmartLoading(previous) && next.smart?.enabled && next.smart.loadingEnabled !== false && next.smart.phase === "unknown" ? { ...next, smart: previous!.smart } : next;
}

export function obsCardPosition(position: OverlayPosition, width: number, height: number): { x: number; y: number } {
  const margin = 24, cardWidth = 400, cardHeight = 148;
  const left = margin, right = Math.max(left, width - margin - cardWidth);
  const top = margin, bottom = Math.max(top, height - margin - cardHeight);
  if (position.startsWith("bottom-")) {
    const slot = Number(position.slice(7));
    return { x: left + (right - left) * (Math.min(6, Math.max(1, slot)) - 1) / 5, y: bottom };
  }
  return {
    x: position.endsWith("left") ? left : position.endsWith("center") ? (left + right) / 2 : right,
    y: position.startsWith("middle") ? (top + bottom) / 2 : top
  };
}

function count(value: number | null | undefined): string { return value === null || value === undefined ? "—" : String(value); }

export function ObsOpponentCard({ opponent, language }: { readonly opponent: ObsOpponent; readonly language: AppLanguage }) {
  const text = labels[language];
  const theme = ["Terran", "Zerg", "Protoss", "Random"].includes(opponent.race) ? opponent.race.toLowerCase() : "unknown";
  const portrait = portraits[opponent.race];
  return <article className={`overlay-card obs-opponent-card theme-${theme}`} aria-label={text.opponent}>
    <div className="overlay-portrait" aria-hidden="true">
      {portrait ? <img className="overlay-portrait-image" src={portrait} alt="" /> : null}
    </div>
    <div className="obs-opponent-content">
      <h1 className="overlay-nickname" title={opponent.nickname}>{opponent.nickname}</h1>
      <div className="obs-opponent-race">{opponent.race === "Unknown" ? "—" : opponent.race}{opponent.league ? ` · ${opponent.league}` : ""}</div>
      <dl className="obs-opponent-stats">
        <div><dt>MMR</dt><dd>{count(opponent.mmr)}</dd></div>
        <div><dt>{text.encounters}</dt><dd>{count(opponent.encounters)}</dd></div>
        <div><dt>W</dt><dd>{count(opponent.wins)}</dd></div>
        <div><dt>L</dt><dd>{count(opponent.losses)}</dd></div>
      </dl>
    </div>
  </article>;
}

/** Standalone OBS page: no native bridge, storage access or write endpoints. */
export function ObsOverlayCanvas() {
  const [snapshot, setSnapshot] = useState<{ state: ObsOverlayState; receivedAt: number } | null>(null);
  const [clock, setClock] = useState(() => performance.now());
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    if (snapshot) document.documentElement.lang = snapshot.state.language;
  }, [snapshot?.state.language]);
  useEffect(() => {
    let stopped = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | undefined;
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    const expiration = setInterval(() => setClock(performance.now()), 250);
    async function poll() {
      const controller = new AbortController();
      inflight = controller;
      const deadline = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch("/api/overlay/state", { cache: "no-store", credentials: "omit", mode: "same-origin", signal: controller.signal });
        if (!response.ok) throw Error("Overlay state unavailable");
        const state = parseObsOverlayState(await response.json());
        if (!stopped) {
          if (!state) setSnapshot((previous) => retainSmartLoading(previous?.state ?? null) ? previous : null);
          else setSnapshot((previous) => ({ state: mergeSmartSnapshot(previous?.state ?? null, state), receivedAt: performance.now() }));
        }
      } catch {
        // A brief reconnect keeps the last fresh frame; expiration removes stale data.
      } finally {
        clearTimeout(deadline);
        if (inflight === controller) inflight = undefined;
        if (!stopped) next = setTimeout(poll, 750);
      }
    }
    void poll();
    return () => { stopped = true; inflight?.abort(); clearTimeout(next); clearInterval(expiration); window.removeEventListener("resize", resize); };
  }, []);
  if (!snapshot) return null;
  const { state } = snapshot;
  const cardVisible = visibleObsState(state, snapshot.receivedAt, clock);
  const fresh = clock - snapshot.receivedAt <= STALE_MS && Math.abs(Date.now() - Date.parse(state.generatedAt)) <= STALE_MS;
  const smartVisible = Boolean(state.smart?.enabled && state.smart.mode.enabled && state.smart.phase !== "unknown" && (fresh || retainSmartLoading(state)));
  if (!cardVisible && !smartVisible) return null;
  const scale = Math.min(viewport.width / state.width, viewport.height / state.height);
  const position = obsCardPosition(state.position, state.width, state.height);
  const stage: CSSProperties = { width: state.width, height: state.height, transform: `scale(${scale})`, left: (viewport.width - state.width * scale) / 2, top: (viewport.height - state.height * scale) / 2 };
  return <main className="obs-stage" style={stage} aria-label={labels[state.language].overlay}>
    {smartVisible && state.smart ? <SmartOverlayLayer smart={state.smart} language={state.language} /> : null}
    {cardVisible ? <div className="obs-widget" style={{ left: position.x, top: position.y }}><ObsOpponentCard opponent={state.opponent!} language={state.language} /></div> : null}
  </main>;
}
