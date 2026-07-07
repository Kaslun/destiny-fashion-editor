import { describe, it, expect } from "vitest";
import { pbrFromDetail, dyeSetFromGearDyes } from "./gearDye";

describe("pbrFromDetail — material classification", () => {
  it("cloth flag is authoritative — fabric regardless of detail name", () => {
    // Even a 'metal' name must yield dielectric when Bungie flags cloth:true.
    const r = pbrFromDetail("327503503_metal_grunge00_dif", "x_norm", true);
    expect(r.metalness).toBe(0);
    expect(r.roughness).toBeGreaterThan(0.7);
  });

  it("classifies metal_grunge diffuse as metallic when not cloth", () => {
    const r = pbrFromDetail("327503503_metal_grunge00_dif", "327503503_gear_detail_leather_worn_norm", false);
    expect(r.metalness).toBe(1);
  });

  it("classifies weave/felt as fabric via name when cloth flag absent", () => {
    const r = pbrFromDetail("327503503_gear_detail_weave_dif", "327898660_gear_detail_needle_felt_norm");
    expect(r.metalness).toBe(0);
    expect(r.roughness).toBeGreaterThan(0.7);
  });

  it("classifies battleworn armor plate as dielectric mid-roughness", () => {
    const r = pbrFromDetail("327503503_gear_detail_armor_battleworn_dif", "327503503_gear_detail_vestian_v530_norm", false);
    expect(r.metalness).toBe(0);
    expect(r.roughness).toBeCloseTo(0.6);
  });

  it("never leaves the muddy 0.5 metalness default", () => {
    const r = pbrFromDetail(null, null);
    expect(r.metalness).not.toBe(0.5);
  });
});

describe("dyeSetFromGearDyes — Chatterwhite (hash 3470260969), real payload", () => {
  const chatterwhite = {
    "0": { primary: [0.797686, 0.778349, 0.716105], secondary: [0.860511, 0.725261, 0.648643], detailDiffuse: "327503503_gear_detail_armor_battleworn_dif", detailNormal: "327503503_gear_detail_vestian_v530_norm", detailTransform: [1.5, 1.5, 0, 0], cloth: false },
    "1": { primary: [0.792067, 0.867009, 0.882303], secondary: [0.588113, 0.49189, 0.425491], detailDiffuse: "327503503_gear_detail_weave_dif", detailNormal: "327898660_gear_detail_needle_felt_norm", detailTransform: [3, 3, 0, 0], cloth: true },
    "2": { primary: [0.371514, 0.438406, 0.511842], secondary: [0.723272, 0.559786, 0.452045], detailDiffuse: "327503503_metal_grunge00_dif", detailNormal: "327503503_gear_detail_leather_worn_norm", detailTransform: [1, 1, 0, 0], cloth: false },
  };

  it("slot 1 cloth:true -> fabric, slot 2 metal_grunge -> metal, slot 0 plate -> dielectric", () => {
    const set = dyeSetFromGearDyes(chatterwhite as any);
    expect(set[1].metalness).toBe(0);   // cloth flag
    expect(set[2].metalness).toBe(1);   // metal name, not cloth
    expect(set[0].metalness).toBe(0);   // armor plate
  });
});

describe("dyeSetFromGearDyes — AION Renewal Vest (hash 3218422834), real payload", () => {
  // The original metallic-render report was against the WRONG item hash
  // (267759883, no gear asset). 3218422834 is the actual vest.
  const aion = {
    "0": { primary: [0.584078, 0.568591, 0.570267], secondary: [0.149658, 0.140382, 0.137366], detailDiffuse: "3104558709_edz_common_1_armor_dif", detailNormal: "327503503_gear_detail_metal_norm", detailTransform: [1, 1, 0, 0], cloth: false },
    "1": { primary: [0.797507, 0.3564, 0.051269], secondary: [0.606754, 0.137593, 0.005058], detailDiffuse: "327503503_gear_detail_fabric_002_dif", detailNormal: "327898660_gore-tex_fabric_norm", detailTransform: [0.775, 0.775, 0, 0], cloth: true },
    "2": { primary: [0.12738, 0.13384, 0.124219], secondary: [0.037284, 0.045939, 0.035679], detailDiffuse: "327503503_gear_detail_crust1_overdif", detailNormal: "327503503_gear_detail_fallen_pattern_norm", detailTransform: [2, 2, 0, 0], cloth: false },
  };

  it("no slot renders as raw metal; the cloth slot is dielectric", () => {
    const set = dyeSetFromGearDyes(aion as any);
    // slot 0: armor diffuse + metal NORMAL, but normal isn't used for the metal
    // decision, so it stays dielectric plate — NOT metallic.
    expect(set[0].metalness).toBe(0);
    // slot 1: cloth flag wins.
    expect(set[1].metalness).toBe(0);
    expect(set[1].roughness).toBeGreaterThan(0.7);
    // slot 2: grimy overlay, no metal keyword.
    expect(set[2].metalness).toBe(0);
  });
});

describe("dyeSetFromGearDyes — detailStrength from material_params[0] (Nighthawk 3960926756)", () => {
  // Real Nighthawk data: slot 0 (gold, Kevlar detail) material_params[0]=0,
  // slot 1 (cloth, fabric detail) =1. Strength 0 must suppress the weave that
  // was stamping across the gold faceplate.
  const nighthawk = {
    "0": { primary: [0.995, 0.74, 0.208], secondary: [0.877, 0.908, 0.908], detailDiffuse: "3104558709_Kevlar_dif", detailNormal: "3104558709_Kevlar_norm", detailTransform: [7.5, 7.5, 0, 0], cloth: false, materialParams: [0, 0, 0, 1] },
    "1": { primary: [0.0996, 0.0366, 0.0256], secondary: [0.224, 0.158, 0.053], detailDiffuse: "401755037_detail_fabric01_dif", detailNormal: "401755037_detail_fabric01_norm", detailTransform: [4, 4, 0, 0], cloth: true, materialParams: [1, 1, 0, 0] },
    "2": { primary: [0.131, 0.117, 0.11], secondary: [0.061, 0.031, 0.021], detailDiffuse: "3104558709_Rubber_01_dif", detailNormal: "3104558709_Rubber_01_norm", detailTransform: [5, 5, 0, 0], cloth: false, materialParams: [1, 1, 0, 0] },
  };

  it("gold faceplate (slot 0) gets zero detail strength -> no weave", () => {
    const set = dyeSetFromGearDyes(nighthawk as any);
    expect(set[0].detailStrength).toBe(0);
  });

  it("cloth (slot 1) gets full detail strength", () => {
    const set = dyeSetFromGearDyes(nighthawk as any);
    expect(set[1].detailStrength).toBe(1);
  });
});

describe("pbrFromDetail — corpus-derived material families (15-item dataset)", () => {
  it("carbon fiber (Metro Shift slot0) -> metal", () => {
    expect(pbrFromDetail("327503503_gear_carbon_fiber_dif", "327503503_gear_carbon_fiber_norm", false, 0.23).metalness).toBe(1);
  });
  it("brushed metal (Synthoceps slot0) -> metal", () => {
    expect(pbrFromDetail("327503503_gear_detail_metal_brushed_dif", "x_norm", false, 0.16).metalness).toBe(1);
  });
  it("battleworn_metal -> metal", () => {
    expect(pbrFromDetail("3104558709_battleworn_metal_01_dif", "x", false).metalness).toBe(1);
  });
  it("galvanized armor -> metal", () => {
    expect(pbrFromDetail("327503503_gear_detail_armor_galvanized_dif", "x", false).metalness).toBe(1);
  });
  it("leather (Lucky Pants slot2) -> dielectric mid-rough", () => {
    const r = pbrFromDetail("327503503_gear_detail_leather2_dif", "x", false);
    expect(r.metalness).toBe(0);
  });
  it("rubber -> dielectric", () => {
    expect(pbrFromDetail("3104558709_Rubber_01_dif", "x", false).metalness).toBe(0);
  });
  it("cotton_fabric via name (no cloth flag) -> dielectric high-rough", () => {
    const r = pbrFromDetail("327503503_gear_detail_cotton_fabric_d2_dif", "x", false);
    expect(r.metalness).toBe(0);
    expect(r.roughness).toBeGreaterThan(0.6);
  });
  it("generic hive_pattern / armor_battleworn -> dielectric default", () => {
    expect(pbrFromDetail("327503503_gear_detail_hive_pattern_dif", "x", false).metalness).toBe(0);
    expect(pbrFromDetail("327503503_gear_detail_armor_battleworn_dif", "x", false).metalness).toBe(0);
  });
  it("roughness_remap max lowers roughness for metal (gloss hint)", () => {
    const glossy = pbrFromDetail("metal_dif", "x", false, 0.12).roughness;
    const noHint = pbrFromDetail("metal_dif", "x", false).roughness;
    expect(glossy).toBeLessThanOrEqual(noHint);
  });
});