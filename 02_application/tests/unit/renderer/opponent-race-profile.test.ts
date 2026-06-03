import { describe, expect, it } from "vitest";
import { playstyleFromTags, raceThemeFor } from "../../../src/renderer/components/OpponentRaceProfile.js";

describe("raceThemeFor", () => {
  it("maps each canonical race to its theme key", () => {
    expect(raceThemeFor("Terran")).toBe("terran");
    expect(raceThemeFor("Zerg")).toBe("zerg");
    expect(raceThemeFor("Protoss")).toBe("protoss");
  });

  it("falls back to the random theme for Random and Unknown", () => {
    expect(raceThemeFor("Random")).toBe("random");
    expect(raceThemeFor("Unknown")).toBe("random");
  });
});

describe("playstyleFromTags", () => {
  it("returns zeroes when no tags are present", () => {
    expect(playstyleFromTags([])).toEqual({ aggression: 0, economy: 0, unpredictable: 0 });
  });

  it("scores aggressive tags higher on the aggression bar", () => {
    const score = playstyleFromTags(["early-pressure", "rush", "macro"]);
    expect(score.aggression).toBeGreaterThan(score.economy);
  });

  it("recognizes direct aggressive and cheese tags as aggression", () => {
    const score = playstyleFromTags(["aggressive", "cheese", "macro"]);
    expect(score.aggression).toBeGreaterThan(score.economy);
  });

  it("recognizes common all-in and cheese shorthand as aggression", () => {
    const score = playstyleFromTags(["allin", "cannon rush", "12 pool", "fast expand"]);
    expect(score.aggression).toBeGreaterThan(score.economy);
    expect(score.aggression).toBeGreaterThan(score.unpredictable);
  });

  it("recognizes compact versions of long playstyle tags", () => {
    const score = playstyleFromTags(["battlecruiser ru", "static defense", "dark templar"]);
    expect(score.aggression).toBeGreaterThan(0);
    expect(score.economy).toBeGreaterThan(0);
    expect(score.unpredictable).toBeGreaterThan(0);
  });

  it("scores macro tags higher on the economy bar", () => {
    const score = playstyleFromTags(["macro", "turtle", "rush"]);
    expect(score.economy).toBeGreaterThan(score.aggression);
  });

  it("recognizes expansion and defensive tags as economy", () => {
    const score = playstyleFromTags(["fast expand", "third", "defensive", "proxy"]);
    expect(score.economy).toBeGreaterThan(score.aggression);
  });

  it("clamps every dimension into [0, 1]", () => {
    const score = playstyleFromTags(["rush", "rush", "early", "early", "all-in"]);
    expect(score.aggression).toBeGreaterThan(0);
    expect(score.aggression).toBeLessThanOrEqual(1);
    expect(score.economy).toBeGreaterThanOrEqual(0);
    expect(score.economy).toBeLessThanOrEqual(1);
    expect(score.unpredictable).toBeGreaterThanOrEqual(0);
    expect(score.unpredictable).toBeLessThanOrEqual(1);
  });

  it("recognizes tricky tech and harassment tags as unpredictable", () => {
    const score = playstyleFromTags(["hidden tech", "dt", "nydus", "drop play"]);
    expect(score.unpredictable).toBeGreaterThan(score.aggression);
    expect(score.unpredictable).toBeGreaterThan(score.economy);
  });

  it("recognizes Russian aggression tags", () => {
    const score = playstyleFromTags(["чиз", "ранний пуш", "прокси", "макро"]);
    expect(score.aggression).toBeGreaterThan(score.economy);
    expect(score.aggression).toBeGreaterThan(score.unpredictable);
  });

  it("recognizes Russian macro and economy tags", () => {
    const score = playstyleFromTags(["макро", "экономика", "третья база", "раш"]);
    expect(score.economy).toBeGreaterThan(score.aggression);
    expect(score.economy).toBeGreaterThan(score.unpredictable);
  });

  it("recognizes Russian tricky and tech tags as unpredictable", () => {
    const score = playstyleFromTags(["скрытый тех", "дроп", "нидус", "макро"]);
    expect(score.unpredictable).toBeGreaterThan(score.aggression);
    expect(score.unpredictable).toBeGreaterThan(score.economy);
  });

  it("ignores unrelated tags instead of treating them as unpredictable", () => {
    const score = playstyleFromTags(["asdf", "qwer", "unknown"]);
    expect(score).toEqual({ aggression: 0, economy: 0, unpredictable: 0 });
  });

  it("does not dilute recognized tags with unrelated tags", () => {
    const score = playstyleFromTags(["rush", "asdf", "unknown"]);
    expect(score.aggression).toBe(1);
    expect(score.economy).toBe(0);
    expect(score.unpredictable).toBe(0);
  });
});
