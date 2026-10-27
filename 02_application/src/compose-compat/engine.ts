/** Transitional domain adapter. Pure snapshot repositories never open the user's data files. */
import type { Opponent } from "../domain/entities/opponent.js";
import type { Match, ReplayMetadata } from "../domain/entities/match.js";
import type { GameSession } from "../domain/entities/game-session.js";
import type { EnrichmentCandidateSnapshot } from "../domain/entities/enrichment-candidate-snapshot.js";
import type { OpponentDataCandidate, OpponentSearchQuery, OpponentDataSourcePort } from "../domain/ports/opponent-data-source-port.js";
import { OpponentEnrichmentService } from "../application/services/opponent-enrichment-service.js";
import { HandleDetectedGame } from "../application/use-cases/handle-detected-game.js";
import { ProcessNewReplay } from "../application/use-cases/process-new-replay.js";
import { SyncReplayArchive } from "../application/use-cases/sync-replay-archive.js";
import { Sc2PulseAdapter } from "../infrastructure/opponent-sources/sc2-pulse-adapter.js";
import { CachedOpponentDataSource } from "../infrastructure/opponent-sources/cached-opponent-data-source.js";
import { BinaryReplayMetadataReader } from "../infrastructure/replay/binary-replay-metadata-reader.js";
import { SidecarReplayMetadataReader } from "../infrastructure/replay/sidecar-replay-metadata-reader.js";
import { Sc2ReplayAnalysisReader } from "../infrastructure/replay/sc2-replay-analysis-reader.js";
import type { ReplayFile } from "../domain/ports/replay-metadata-reader-port.js";
import { readPostmatchFacts } from "./postmatch-facts.js";
import { readCachedMapImage } from "./map-assets.js";

type RecordWithId = { readonly id: string };
class SnapshotRepository<T extends RecordWithId> {
  private readonly records: Map<string, T>;
  constructor(records: readonly T[]) {
    if (!Array.isArray(records) || records.some((r) => !r || typeof r.id !== "string" || !r.id)) {
      throw new Error("Invalid compatibility snapshot records.");
    }
    this.records = new Map(records.map((r) => [r.id, structuredClone(r)]));
    if (this.records.size !== records.length) throw new Error("Duplicate snapshot identity.");
  }
  async findAll(): Promise<readonly T[]> { return [...this.records.values()]; }
  async findById(id: string): Promise<T | null> { return this.records.get(id) ?? null; }
  async save(record: T): Promise<void> { this.records.set(record.id, { ...this.records.get(record.id), ...record }); }
  async clear(): Promise<void> { this.records.clear(); }
}
class Matches extends SnapshotRepository<Match> {
  async findByOpponentId(id: string): Promise<readonly Match[]> { return (await this.findAll()).filter((m) => m.opponentId === id); }
}
class Candidates extends SnapshotRepository<EnrichmentCandidateSnapshot> {
  async findByOpponentId(id: string): Promise<readonly EnrichmentCandidateSnapshot[]> { return (await this.findAll()).filter((c) => c.opponentId === id); }
  async replaceForOpponent(id: string, next: readonly EnrichmentCandidateSnapshot[]): Promise<void> {
    const others = (await this.findAll()).filter((c) => c.opponentId !== id);
    await this.clear();
    for (const record of [...others, ...next]) await this.save(record);
  }
}

export type CompatibilityPayload = {
  readonly records?: {
    readonly opponents: readonly Opponent[];
    readonly matches: readonly Match[];
    readonly candidates: readonly EnrichmentCandidateSnapshot[];
    readonly fixtures?: readonly OpponentDataCandidate[];
    readonly sourceCache?: unknown;
  };
  readonly settings?: { readonly externalSourcesEnabled?: boolean; readonly externalSources?: { readonly sc2Pulse?: boolean; readonly localFixture?: boolean } };
  readonly session?: GameSession;
  readonly metadata?: ReplayMetadata;
  readonly file?: ReplayFile;
  readonly userName?: string;
  readonly region?: OpponentSearchQuery["region"];
  readonly replayPath?: string;
  readonly opponentName?: string;
  readonly duration?: number;
  readonly mapSha256?: string;
};

export async function executeCompatibility(command: string, payload: CompatibilityPayload): Promise<unknown> {
  if(command === "mapImage") return readCachedMapImage(payload.mapSha256);
  if (command === "postMatchFacts") {
    if (!payload.replayPath) throw new Error("Missing replay path.");
    return readPostmatchFacts(payload.replayPath, payload.duration);
  }
  if (command === "metadata") {
    if (!payload.file) throw new Error("Missing replay file.");
    return new BinaryReplayMetadataReader({ fallback: new SidecarReplayMetadataReader(), resolveUserName: async () => payload.userName }).readMetadata(payload.file);
  }
  if (command === "analysis") {
    if (!payload.replayPath) throw new Error("Missing replay path.");
    return new Sc2ReplayAnalysisReader().readAnalysis(payload.replayPath, payload.opponentName);
  }
  if (!payload.records) throw new Error("Missing domain snapshot.");
  const opponents = new SnapshotRepository(payload.records.opponents);
  const matches = new Matches(payload.records.matches);
  const candidates = new Candidates(payload.records.candidates);
  const sources: OpponentDataSourcePort[] = [];
  let sc2Pulse: CachedOpponentDataSource | undefined;
  if (payload.settings?.externalSourcesEnabled) {
    if (payload.settings.externalSources?.sc2Pulse) {
      sc2Pulse = new CachedOpponentDataSource(new Sc2PulseAdapter());
      sc2Pulse.restoreState(payload.records.sourceCache);
      sources.push(sc2Pulse);
    }
    if (payload.settings.externalSources?.localFixture) {
      const fixtures = payload.records.fixtures ?? [];
      sources.push({
        sourceName: "Local Fixture Source",
        searchOpponent: async (query) => fixtures.filter((candidate) => {
          const names = [candidate.nickname, ...(candidate.aliases ?? [])].map((n) => n.trim().toLowerCase());
          const name = query.nickname.trim().toLowerCase();
          return name && names.some((n) => n === name || n.includes(name))
            && (!query.race || candidate.race === "Unknown" || candidate.race === query.race);
        })
      });
    }
  }
  const enrichmentService = new OpponentEnrichmentService(sources);
  let result: unknown;
  if (command === "registerDetectedGame") {
    if (!payload.session) throw new Error("Missing detected session.");
    result = await new HandleDetectedGame({ opponentRepository: opponents, matchRepository: matches, enrichmentCandidateRepository: candidates, enrichmentService })
      .execute({ session: payload.session, userName: payload.userName, region: payload.region });
  } else if (command === "processReplay") {
    if (!payload.metadata) throw new Error("Missing replay metadata.");
    result = await new ProcessNewReplay(matches, opponents, undefined, {
      enrichmentService, enrichmentCandidateRepository: candidates,
      resolveLocalPlayerNames: () => payload.userName ? [payload.userName] : []
    }).execute(payload.metadata);
  } else if (command === "syncReplay") {
    if (!payload.metadata || !payload.file || !payload.userName) throw new Error("Missing sync replay inputs.");
    result = await new SyncReplayArchive({
      replayFileScanner: { scan: async () => [payload.file!] },
      replayMetadataReader: { readMetadata: async () => payload.metadata! },
      opponentRepository: opponents, matchRepository: matches,
      enrichmentCandidateRepository: candidates, enrichmentService
    }).execute({ directory: "snapshot", userName: payload.userName, region: payload.region, mode: "full" });
  } else {
    throw new Error(`Unsupported compatibility command: ${command}`);
  }
  const records: Record<string, unknown> = { opponents: await opponents.findAll(), matches: await matches.findAll(), candidates: await candidates.findAll() };
  if (sc2Pulse) records.sourceCache = sc2Pulse.exportState();
  else if (payload.records.sourceCache !== undefined) records.sourceCache = payload.records.sourceCache;
  return { result, records };
}
