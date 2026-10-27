import type { MenuWidgetKind, PostmatchStatus } from "../../shared/ipc/contracts.js";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown, limit = 256): value is string => typeof value === "string" && value.length <= limit;
const schematicBackground = () => ({ status: "unavailable", reason: "No local map image; schematic based on replay positions" });
/** Images must come from the native content-addressed map endpoint, never arbitrary URLs. */
export function parseMapBackground(value: unknown, expectedMapSha?: unknown): Record<string, unknown> {
  if (!object(value) || value.status !== "ready" || typeof value.map_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.map_sha256)
    || typeof value.image_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.image_sha256)
    || value.url !== `/api/overlay/maps/${value.image_sha256}/image`
    || (expectedMapSha !== undefined && expectedMapSha !== null && expectedMapSha !== value.map_sha256)
    || !["editor-export", "minimap"].includes(String(value.source_kind))
    || !Array.isArray(value.image_size) || value.image_size.length !== 2 || !value.image_size.every((n) => Number.isInteger(n) && n > 0 && n <= 4096)
    || !object(value.bounds) || ![value.bounds.min_x, value.bounds.min_y, value.bounds.max_x, value.bounds.max_y].every(finite)
    || !object(value.registration) || !["approximate", "validated"].includes(String(value.registration.accuracy))) return schematicBackground();
  const bounds = value.bounds as Record<string, number>;
  if (!(bounds.min_x >= 0 && bounds.min_y >= 0 && bounds.max_x <= 4096 && bounds.max_y <= 4096 && bounds.max_x > bounds.min_x && bounds.max_y > bounds.min_y)) return schematicBackground();
  const [width, height] = value.image_size as number[];
  if (Math.abs(height - width * (bounds.max_y - bounds.min_y) / (bounds.max_x - bounds.min_x)) > 1.000001) return schematicBackground();
  return { status: "ready", map_sha256: value.map_sha256, image_sha256: value.image_sha256, source_kind: value.source_kind,
    url: value.url, image_size: [width, height], bounds: { min_x: bounds.min_x, min_y: bounds.min_y, max_x: bounds.max_x, max_y: bounds.max_y },
    registration: { accuracy: value.registration.accuracy } };
}
export function parsePostmatchStatus(value: unknown): PostmatchStatus | null {
  if (!object(value) || !["empty", "processing", "ready", "error"].includes(String(value.status)) || typeof value.available !== "boolean" || typeof value.visible !== "boolean") return null;
  if (value.id !== undefined && (!text(value.id, 160) || !value.id)) return null;
  if (value.startedAt !== undefined && (!finite(value.startedAt) || value.startedAt <= 0)) return null;
  if (value.status === "ready" && (!value.id || !finite(value.startedAt))) return null;
  return value as PostmatchStatus;
}
function events(value: unknown, limit: number, duration: number): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > limit) return false;
  let last = -1;
  return value.every((event) => {
    if (!object(event) || !finite(event.at) || event.at < last || event.at < 0 || event.at > duration || !finite(event.tick) || event.tick < 0) return false;
    last = event.at;
    return ["x", "y"].every((key) => event[key] == null || finite(event[key])) && (event.tag == null || Number.isSafeInteger(event.tag))
      && (event.unit === undefined || text(event.unit, 160)) && (event.owner_name == null || text(event.owner_name));
  });
}
/** The old renderers consume public facts only; paths, remote images and icon URLs are discarded. */
export function parsePostmatchPayload(value: unknown, expectedId: string, kind: MenuWidgetKind): Record<string, unknown> | null {
  if (!object(value) || value.id !== expectedId || !finite(value.duration) || value.duration <= 0 || value.duration > 120
    || !finite(value.timeline_seconds) || value.timeline_seconds <= 0 || value.timeline_seconds > value.duration
    || !finite(value.game_seconds) || value.game_seconds < 0 || !finite(value.elapsed_gameloops) || value.elapsed_gameloops <= 0 || !text(value.map)
    || !Array.isArray(value.teams) || value.teams.length < 2 || value.teams.length > 32 || !value.teams.every((team) => object(team) && text(team.label, 512))
    || !events(value.events, 10000, value.duration) || !value.events.every((event) => Number.isInteger(event.team) && Number(event.team) >= 0 && Number(event.team) < (value.teams as unknown[]).length && text(event.id, 160) && text(event.unit, 160))
    || !object(value.story) || value.story.schema_version !== 1 || !events(value.story.events, 50000, value.duration)
    || !Array.isArray(value.resource_timeline) || value.resource_timeline.length > 20000
    || !value.resource_timeline.every((sample) => object(sample) && finite(sample.at) && sample.at >= 0 && sample.at <= Number(value.duration) && Number.isInteger(sample.team) && Number(sample.team) >= 0 && Number(sample.team) < (value.teams as unknown[]).length && finite(sample.tick) && ["minerals", "gas"].every((key) => sample[key] === null || (finite(sample[key]) && sample[key] >= 0)))) return null;
  const story = value.story;
  const validTeam = (team: unknown) => team == null || (Number.isInteger(team) && Number(team) >= 0 && Number(team) < (value.teams as unknown[]).length);
  if (!(story.events as Record<string, unknown>[]).every((event) => validTeam(event.team))) return null;
  if (story.movement !== undefined) {
    if (!object(story.movement)) return null;
    if (story.movement.samples !== undefined && (!events(story.movement.samples, 40000, value.duration) || story.movement.samples.some((sample) => !Number.isSafeInteger(sample.tag) || !validTeam(sample.team)))) return null;
  }
  if (value.events.length + (story.events as unknown[]).length + (object(story.movement) && Array.isArray(story.movement.samples) ? story.movement.samples.length : 0) > 70000) return null;
  const bounds = object(story.bounds) && [story.bounds.min_x, story.bounds.max_x, story.bounds.min_y, story.bounds.max_y].every(finite)
    && Number(story.bounds.max_x) > Number(story.bounds.min_x) && Number(story.bounds.max_y) > Number(story.bounds.min_y) ? story.bounds : null;
  const cleanEvents = (rows: Record<string, unknown>[]) => rows.map((event) => ({ ...event, icon: typeof event.icon === "string" && /^[a-zA-Z0-9_-]{1,120}(?:\.(?:png|webp))?$/.test(event.icon) ? event.icon : null }));
  return { ...value, animation: kind, events: cleanEvents(value.events), story: { ...story, bounds, events: cleanEvents(story.events as Record<string, unknown>[]) }, map_background: parseMapBackground(value.map_background, value.map_sha256) };
}

export type PostmatchPollingOptions = {
  readonly kind: MenuWidgetKind; readonly preview: boolean;
  readonly fetch?: typeof fetch;
  readonly onPayload: (payload: Record<string, unknown>, startedAt: number) => void;
  readonly onEmpty: (status: "empty" | "processing" | "error" | "hidden") => void;
};
/** One small status request per iteration; heavy facts are cached by immutable id. */
export function startPostmatchPolling(options: PostmatchPollingOptions): () => void {
  const fetcher = options.fetch ?? fetch;
  let stopped = false, identity = "", cachedId = "";
  let cached: Record<string, unknown> | null = null;
  let next: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;
  const suffix = options.preview ? "?preview=1" : "";
  async function poll() {
    const controller = new AbortController(); inflight = controller;
    const deadline = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetcher(`/api/overlay/postmatch/status${suffix}`, { signal: controller.signal, cache: "no-store", credentials: "omit", mode: "same-origin" });
      if (!response.ok) throw Error("Postmatch status unavailable");
      const status = parsePostmatchStatus(await response.json());
      if (!status) throw Error("Invalid postmatch status");
      if (stopped) return;
      if (!options.preview && status.status === "ready" && status.available && !status.visible) { identity = ""; options.onEmpty("hidden"); return; }
      if (!status.available || status.status !== "ready") { identity = ""; options.onEmpty(status.status === "processing" ? "processing" : status.status === "error" ? "error" : "empty"); return; }
      const key = `${status.id}:${status.startedAt}`;
      if (identity === key) return;
      // A new presentation can upgrade the map asset while replay facts keep their immutable ID.
      if (cachedId !== key || !cached) {
        const data = await fetcher(`/api/overlay/postmatch/data?id=${encodeURIComponent(status.id!)}${options.preview ? "&preview=1" : ""}`, { signal: controller.signal, cache: "no-store", credentials: "omit", mode: "same-origin" });
        if (!data.ok || data.status === 204) { if (!stopped) options.onEmpty("empty"); return; }
        const payload = parsePostmatchPayload(await data.json(), status.id!, options.kind);
        if (!payload) throw Error("Invalid postmatch data");
        cached = payload; cachedId = key;
      }
      if (!stopped) { identity = key; options.onPayload(cached, options.preview ? Date.now() / 1000 : status.startedAt!); }
    } catch { if (!stopped) { identity = ""; options.onEmpty("error"); } }
    finally { clearTimeout(deadline); inflight = undefined; if (!stopped) next = setTimeout(poll, 750); }
  }
  void poll();
  return () => { stopped = true; inflight?.abort(); clearTimeout(next); };
}
