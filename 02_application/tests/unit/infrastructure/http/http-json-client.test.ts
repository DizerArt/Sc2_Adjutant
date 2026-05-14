import { describe, expect, it, vi } from "vitest";
import { HttpJsonClient } from "../../../../src/infrastructure/http/http-json-client.js";

describe("HttpJsonClient", () => {
  it("fetches JSON with default accept header", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        accept: "application/json"
      });

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new HttpJsonClient({ fetchImpl });
    const result = await client.getJson<{ ok: boolean }>("https://example.test/data");

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries retryable failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new HttpJsonClient({
      fetchImpl,
      retryCount: 1,
      retryDelayMs: 5,
      sleep: async () => undefined
    });

    await expect(client.getJson("https://example.test/data")).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("waits when min interval has not elapsed", async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new HttpJsonClient({
      fetchImpl,
      minIntervalMs: 100,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      }
    });

    await client.getJson("https://example.test/first");
    now = 1050;
    await client.getJson("https://example.test/second");

    expect(sleeps).toEqual([50]);
  });
});

