import { describe, it, expect } from "vitest";
import { approvedExternalUrl } from "../../../src/renderer/platform/external-links.js";
describe("Tauri external URL policy", () => {
  it("permits incumbent release and support links", () => {
    expect(approvedExternalUrl("https://github.com/DizerArt/Sc2_Adjutant/releases/latest")).toContain("github.com");
    expect(approvedExternalUrl("https://paypal.me/ArturioDiz")).toContain("paypal.me");
  });
  it("rejects file, shell, credentials and unrelated origins", () => {
    for (const url of ["file:///C:/Windows", "javascript:alert(1)", "https://github.com.evil.test", "https://name:secret@github.com/"]) expect(approvedExternalUrl(url)).toBeNull();
  });
});
