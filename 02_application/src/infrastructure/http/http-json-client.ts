import { ExternalSourceError } from "../../shared/errors/external-source-error.js";

export type HttpJsonClientOptions = {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retryCount?: number;
  readonly retryDelayMs?: number;
  readonly minIntervalMs?: number;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type HttpJsonRequestOptions = {
  readonly headers?: Record<string, string>;
};

export class HttpJsonClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly minIntervalMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(options: HttpJsonClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.retryCount = options.retryCount ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.clock = options.clock ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async getJson<T>(url: string, options: HttpJsonRequestOptions = {}): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      await this.waitForRateLimit();

      try {
        return await this.fetchJson<T>(url, options);
      } catch (error) {
        lastError = error;

        if (attempt < this.retryCount && isRetryableError(error)) {
          await this.sleep(this.retryDelayMs);
          continue;
        }

        break;
      }
    }

    if (lastError instanceof ExternalSourceError) {
      throw lastError;
    }

    throw new ExternalSourceError("HTTP_JSON_REQUEST_FAILED", `Unable to fetch JSON from ${url}`, {
      cause: lastError
    });
  }

  private async fetchJson<T>(url: string, options: HttpJsonRequestOptions): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...options.headers
        },
        signal: controller.signal
      });

      this.lastRequestAt = this.clock();

      if (!response.ok) {
        throw new ExternalSourceError("HTTP_JSON_BAD_STATUS", `HTTP ${response.status} while fetching ${url}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ExternalSourceError) {
        throw error;
      }

      throw new ExternalSourceError("HTTP_JSON_REQUEST_FAILED", `Unable to fetch JSON from ${url}`, {
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.minIntervalMs <= 0 || this.lastRequestAt === 0) {
      return;
    }

    const elapsed = this.clock() - this.lastRequestAt;
    const remaining = this.minIntervalMs - elapsed;

    if (remaining > 0) {
      await this.sleep(remaining);
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ExternalSourceError)) {
    return false;
  }

  return error.code === "HTTP_JSON_REQUEST_FAILED" || error.code === "HTTP_JSON_BAD_STATUS";
}

