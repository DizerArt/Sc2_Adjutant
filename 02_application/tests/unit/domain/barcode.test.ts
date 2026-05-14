import { describe, expect, it } from "vitest";
import {
  detectBarcodeIdentity,
  isBarcodeNickname,
  isExactBarcodeCandidate
} from "../../../src/domain/value-objects/barcode.js";

describe("barcode nickname detection", () => {
  it("detects common SC2 barcode names", () => {
    expect(isBarcodeNickname("IIIIIIIII")).toBe(true);
    expect(isBarcodeNickname("llllllll")).toBe(true);
    expect(isBarcodeNickname("|||||||")).toBe(true);
    expect(isBarcodeNickname("IlI1l|")).toBe(true);
  });

  it("rejects short or mixed normal nicknames", () => {
    expect(isBarcodeNickname("Ill")).toBe(false);
    expect(isBarcodeNickname("Lithuviel")).toBe(false);
    expect(isBarcodeNickname("sdTV")).toBe(false);
  });

  it("builds a stable visual fingerprint", () => {
    expect(detectBarcodeIdentity("IlI1l|")).toMatchObject({
      fingerprint: "barcode:6:111111",
      length: 6
    });
  });

  it("requires exact candidate text for automated barcode identity extraction", () => {
    expect(isExactBarcodeCandidate("IIIIII", "IIIIII")).toBe(true);
    expect(isExactBarcodeCandidate("IIIIII", "llllll")).toBe(false);
    expect(isExactBarcodeCandidate("Serral", "Serral")).toBe(false);
  });
});
