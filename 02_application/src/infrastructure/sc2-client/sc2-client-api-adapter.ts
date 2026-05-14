import { toGameSession, type GameSession, type Sc2ClientGamePayload } from "../../domain/entities/game-session.js";
import type { Sc2ClientPort } from "../../domain/ports/sc2-client-port.js";
import { ExternalSourceError } from "../../shared/errors/external-source-error.js";

export type Sc2ClientApiAdapterOptions = {
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
};

export class Sc2ClientApiAdapter implements Sc2ClientPort {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Sc2ClientApiAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? "http://127.0.0.1:6119/game";
    this.timeoutMs = options.timeoutMs ?? 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCurrentGame(): Promise<GameSession> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "GET",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new ExternalSourceError("SC2_CLIENT_API_UNAVAILABLE", `SC2 Client API returned ${response.status}`);
      }

      const payload = (await response.json()) as Sc2ClientGamePayload;
      return toGameSession(payload);
    } catch (error) {
      if (error instanceof ExternalSourceError) {
        throw error;
      }

      throw new ExternalSourceError("SC2_CLIENT_API_UNAVAILABLE", "Unable to read SC2 Client API", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

