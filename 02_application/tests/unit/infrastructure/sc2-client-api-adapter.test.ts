import { describe, expect, it } from "vitest";
import { Sc2ClientApiAdapter } from "../../../src/infrastructure/sc2-client/sc2-client-api-adapter.js";

describe("Sc2ClientApiAdapter", () => {
  it("reads and maps the SC2 Client API payload", async () => {
    const adapter = new Sc2ClientApiAdapter({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            displayTime: 4,
            players: [
              { name: "DizerArt", race: "Terran", isUser: true },
              {
                name: "HiveMindX",
                race: "Zerg",
                profile: {
                  link: "battlenet:://starcraft/profile/2/10220887502839873536",
                  ladder: { mmr: "3872" }
                }
              }
            ]
          }),
          { status: 200 }
        )
    });

    const session = await adapter.getCurrentGame();

    expect(session.mode).toBe("ranked-1v1");
    expect(session.players[1]?.name).toBe("HiveMindX");
    expect(session.players[1]?.profileLink).toBe("battlenet:://starcraft/profile/2/10220887502839873536");
    expect(session.players[1]?.mmr).toBe(3872);
  });

  it("throws a source error when the endpoint fails", async () => {
    const adapter = new Sc2ClientApiAdapter({
      fetchImpl: async () => new Response("offline", { status: 503 })
    });

    await expect(adapter.getCurrentGame()).rejects.toMatchObject({
      name: "ExternalSourceError",
      code: "SC2_CLIENT_API_UNAVAILABLE"
    });
  });
});
