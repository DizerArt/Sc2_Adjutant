import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppDataDirectory } from "../../../../src/infrastructure/storage/app-data-directory.js";

describe("resolveAppDataDirectory", () => {
  it("uses explicit SC2_ASSISTANT_DATA_DIR when provided", () => {
    expect(
      resolveAppDataDirectory({
        SC2_ASSISTANT_DATA_DIR: "D:\\SC2Data",
        APPDATA: "C:\\Users\\Player\\AppData\\Roaming"
      })
    ).toBe("D:\\SC2Data");
  });

  it("uses Windows AppData by default", () => {
    expect(
      resolveAppDataDirectory({
        APPDATA: "C:\\Users\\Player\\AppData\\Roaming"
      })
    ).toBe("C:\\Users\\Player\\AppData\\Roaming\\SC2 Assistant\\data");
  });

  it("falls back to home directory outside Windows", () => {
    expect(
      resolveAppDataDirectory({
        HOME: "/home/player"
      })
    ).toBe(join("/home/player", ".sc2-assistant", "data"));
  });
});
