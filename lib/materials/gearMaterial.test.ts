import { describe, it, expect } from "vitest";
import { pbrFromDetail, dyeSetFromGearDyes } from "./gearDye";

describe("pbrFromDetail — material classification from detail-map names", () => {
  it("classifies fabric detail maps as dielectric + high roughness", () => {
    const r = pbrFromDetail("327503503_gear_detail_weave_dif", "327898660_gear_detail_needle_felt_norm");
    expect(r.metalness).toBe(0);
    expect(r.roughness).toBeGreaterThan(0.7);
  });

  it("classifies metal_grunge diffuse as metallic even with a leather normal", () => {
    const r = pbrFromDetail("327503503_metal_grunge00_dif", "327503503_gear_detail_leather_worn_norm");
    expect(r.metalness).toBe(1);
  });

  it("classifies battleworn armor plate as dielectric mid-roughness", () => {
    const r = pbrFromDetail("327503503_gear_detail_armor_battleworn_dif", "327503503_gear_detail_vestian_v530_norm");
    expect(r.metalness).toBe(0);
    expect(r.roughness).toBeCloseTo(0.6);
  });

  it("never leaves the muddy 0.5 metalness default", () => {
    const r = pbrFromDetail(null, null);
    expect(r.metalness).not.toBe(0.5);
  });
});

describe("dyeSetFromGearDyes — Chatterwhite (hash 3470260969)", () => {
  const chatterwhite = {
    "0": { primary: [0.797686, 0.778349, 0.716105], secondary: [0.860511, 0.725261, 0.648643], detailDiffuse: "327503503_gear_detail_armor_battleworn_dif", detailNormal: "327503503_gear_detail_vestian_v530_norm", detailTransform: [1.5, 1.5, 0, 0] },
    "1": { primary: [0.792067, 0.867009, 0.882303], secondary: [0.588113, 0.49189, 0.425491], detailDiffuse: "327503503_gear_detail_weave_dif", detailNormal: "327898660_gear_detail_needle_felt_norm", detailTransform: [3, 3, 0, 0] },
    "2": { primary: [0.371514, 0.438406, 0.511842], secondary: [0.723272, 0.559786, 0.452045], detailDiffuse: "327503503_metal_grunge00_dif", detailNormal: "327503503_gear_detail_leather_worn_norm", detailTransform: [1, 1, 0, 0] },
  };

  it("slot 1 (weave/felt) is cloth, slot 2 (metal_grunge) is metal", () => {
    const set = dyeSetFromGearDyes(chatterwhite as any);
    expect(set[1].metalness).toBe(0);   // cloth
    expect(set[2].metalness).toBe(1);   // metal
    expect(set[0].metalness).toBe(0);   // armor plate, dielectric
  });
});