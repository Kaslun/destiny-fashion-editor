import { describe, it, expect } from "vitest";
import {
  dyeSetFromGearDyes,
  dyeForSlot,
  rankSlotsSoftToHard,
  resolveDyeSet,
  neutralizePlaceholderEmissive,
} from "./gearDye";
import type { DyeSet } from "./gearDye";

/** Wire-shape helper matching /api/dyes (lib/bungie/gearDyeData.ts). */
function apiTint(over: Record<string, unknown> = {}) {
  return {
    albedo: [1, 1, 1],
    wornAlbedo: [0.5, 0.5, 0.5],
    metalness: 0,
    wornMetalness: 0,
    detailBlend: 0,
    fuzz: 0,
    roughnessRemap: [0, 1, 0, 1],
    wornRoughnessRemap: [0, 1, 0, 1],
    wearRemap: [0, 0, 0, 0],
    emissive: [0, 0, 0],
    emissiveIntensity: 0,
    sss: 0,
    ...over,
  };
}

describe("dyeSetFromGearDyes — Sunlit Hood slot 0 (2013981053): per-tint metalness from real data", () => {
  // The corpus's clearest proof that metalness is authored PER TINT
  // (material_params[3]), not per slot: black PAINT primary (dielectric)
  // with GOLD secondary (metal) on the same slot.
  const sunlitSlot0 = {
    "0": {
      cloth: false,
      detailDiffuse: "327503503_gear_detail_metal_dif",
      detailNormal: "327503503_gear_detail_metal_hex_norm",
      detailDiffuseTransform: [1.5, 1.5, 0, 0],
      detailNormalTransform: [1.5, 1.5, 0, 0],
      primary: apiTint({ albedo: [0.03515, 0.03515, 0.03515], metalness: 0 }),
      secondary: apiTint({ albedo: [1, 0.6187, 0.275], metalness: 0.85 }),
    },
  };

  it("keeps primary (black paint) dielectric and secondary (gold) metallic", () => {
    const set = dyeSetFromGearDyes(sunlitSlot0);
    expect(set[0].primary.metalness).toBe(0);
    expect(set[0].secondary.metalness).toBe(0.85);
  });

  it("carries separate detail transforms for diffuse and normal", () => {
    const set = dyeSetFromGearDyes(sunlitSlot0);
    expect(set[0].detailDiffuseTransform).toEqual([1.5, 1.5, 0, 0]);
    expect(set[0].detailNormalTransform).toEqual([1.5, 1.5, 0, 0]);
  });
});

describe("dyeSetFromGearDyes — Nighthawk (3960926756), real corpus values", () => {
  const nighthawk = {
    "0": {
      cloth: false,
      detailDiffuse: "3104558709_Kevlar_dif",
      detailNormal: "3104558709_Kevlar_norm",
      detailDiffuseTransform: [7.5, 7.5, 0, 0],
      detailNormalTransform: [7.5, 7.5, 0, 0],
      // gold: material_params [0,0,0,1] -> detailBlend 0, metalness 1
      primary: apiTint({
        albedo: [0.995, 0.7405, 0.2084],
        metalness: 1,
        detailBlend: 0,
        roughnessRemap: [-4.933, 6.667, 0.74, 0.15],
        wearRemap: [-3.406, 4.926, 0, 1],
      }),
      secondary: apiTint({ albedo: [0.8774, 0.9078, 0.9078], metalness: 1 }),
    },
    "1": {
      cloth: true,
      detailDiffuse: "401755037_detail_fabric01_dif",
      detailNormal: "401755037_detail_fabric01_norm",
      detailDiffuseTransform: [4, 4, 0, 0],
      detailNormalTransform: [4, 4, 0, 0],
      // fabric: material_params [1,1,0,0], advanced [-1, 0.15, ...]
      primary: apiTint({
        albedo: [0.09964, 0.0366, 0.02561],
        metalness: 0,
        detailBlend: 1,
        fuzz: 0.15,
      }),
      secondary: apiTint({ albedo: [0.2239, 0.1577, 0.05283] }),
    },
    "2": {
      cloth: false,
      detailDiffuse: "3104558709_Rubber_01_dif",
      detailNormal: "3104558709_Rubber_01_norm",
      detailDiffuseTransform: [5, 5, 0, 0],
      detailNormalTransform: [5, 5, 0, 0],
      primary: apiTint({ albedo: [0.1307, 0.1169, 0.1104], metalness: 0, detailBlend: 1 }),
      secondary: apiTint({ albedo: [0.06107, 0.03137, 0.02065] }),
    },
  };

  it("gold plate (slot 0) has metalness 1 and detail blend 0 — no weave stamped over the gold", () => {
    const set = dyeSetFromGearDyes(nighthawk);
    expect(set[0].primary.metalness).toBe(1);
    expect(set[0].primary.detailBlend).toBe(0);
  });

  it("cloth (slot 1) is dielectric with full detail blend and a fuzz amount", () => {
    const set = dyeSetFromGearDyes(nighthawk);
    expect(set[1].primary.metalness).toBe(0);
    expect(set[1].primary.detailBlend).toBe(1);
    expect(set[1].primary.fuzz).toBeCloseTo(0.15);
  });

  it("remap vec4s pass through untouched (interpretation is the shader's concern)", () => {
    const set = dyeSetFromGearDyes(nighthawk);
    expect(set[0].primary.roughnessRemap).toEqual([-4.933, 6.667, 0.74, 0.15]);
    expect(set[0].primary.wearRemap).toEqual([-3.406, 4.926, 0, 1]);
  });

  it("ranks softest -> hardest as cloth, rubber, gold", () => {
    const set = dyeSetFromGearDyes(nighthawk);
    expect(rankSlotsSoftToHard(set)).toEqual([1, 2, 0]);
  });
});

describe("dyeForSlot — neutral fallback", () => {
  it("returns a neutral (non-metal, no-wear) slot when unresolved", () => {
    const slot = dyeForSlot({}, 1);
    expect(slot.cloth).toBe(false);
    expect(slot.primary.metalness).toBeLessThan(0.5);
    expect(slot.primary.wearRemap).toEqual([0, 0, 0, 0]);
  });
});

describe("resolveDyeSet — locked > custom > default dye priority", () => {
  const tag = (t: string) => ({ tag: t }) as unknown as DyeSet[number];

  it("locked wins over custom and default for the same slot", () => {
    const defaultDyes: DyeSet = { 0: tag("default") };
    const customDyes: DyeSet = { 0: tag("custom") };
    const lockedDyes: DyeSet = { 0: tag("locked") };
    const resolved = resolveDyeSet(defaultDyes, customDyes, lockedDyes);
    expect((resolved[0] as unknown as { tag: string }).tag).toBe("locked");
  });

  it("custom wins over default when the slot isn't locked", () => {
    const defaultDyes: DyeSet = { 0: tag("default") };
    const customDyes: DyeSet = { 0: tag("custom") };
    const resolved = resolveDyeSet(defaultDyes, customDyes, {});
    expect((resolved[0] as unknown as { tag: string }).tag).toBe("custom");
  });

  it("a slot present only in default falls through untouched", () => {
    const defaultDyes: DyeSet = { 1: tag("default-slot1") };
    const resolved = resolveDyeSet(defaultDyes, {}, {});
    expect((resolved[1] as unknown as { tag: string }).tag).toBe("default-slot1");
  });

  it("locked can override just one slot while others resolve to custom/default", () => {
    const defaultDyes: DyeSet = { 0: tag("default0"), 1: tag("default1") };
    const customDyes: DyeSet = { 0: tag("custom0"), 1: tag("custom1") };
    const lockedDyes: DyeSet = { 1: tag("locked1") };
    const resolved = resolveDyeSet(defaultDyes, customDyes, lockedDyes);
    expect((resolved[0] as unknown as { tag: string }).tag).toBe("custom0");
    expect((resolved[1] as unknown as { tag: string }).tag).toBe("locked1");
  });

  it("empty maps are safe (no dyes at all)", () => {
    expect(resolveDyeSet({}, {}, {})).toEqual({});
  });
});

describe("neutralizePlaceholderEmissive — uniform-across-slots default detection", () => {
  it("zeros a placeholder repeated identically across every slot (Relativism: (1,0,0,1) primaries + (1,1,1,1) secondaries)", () => {
    const set = dyeSetFromGearDyes({
      "0": {
        primary: { emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { emissive: [1, 1, 1], emissiveIntensity: 1 },
      },
      "1": {
        primary: { emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { emissive: [1, 1, 1], emissiveIntensity: 1 },
      },
      "2": {
        primary: { emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { emissive: [1, 1, 1], emissiveIntensity: 1 },
      },
    });
    for (const slot of [0, 1, 2]) {
      expect(set[slot].primary.emissive.getHex()).toBe(0x000000);
      expect(set[slot].primary.emissiveIntensity).toBe(0);
      expect(set[slot].secondary.emissive.getHex()).toBe(0x000000);
      expect(set[slot].secondary.emissiveIntensity).toBe(0);
    }
  });

  it("preserves a real per-slot glow (Nighthawk: gold eye on slot 0 only, black on 1 & 2)", () => {
    const set = dyeSetFromGearDyes({
      "0": {
        primary: { emissive: [0.87, 0.157, 0.043], emissiveIntensity: 1 },
        secondary: { emissive: [0.87, 0.157, 0.043], emissiveIntensity: 1 },
      },
      "1": { primary: { emissive: [0, 0, 0] }, secondary: { emissive: [0, 0, 0] } },
      "2": { primary: { emissive: [0, 0, 0] }, secondary: { emissive: [0, 0, 0] } },
    });
    // slot 0's authored gold survives — not all slots contribute, so it's not
    // the uniform placeholder signature.
    expect(set[0].primary.emissive.r).toBeCloseTo(0.87);
    expect(set[0].primary.emissiveIntensity).toBe(1);
  });

  it("neutralizes one parity independently of the other", () => {
    // primaries are a uniform placeholder; secondaries carry a real per-slot
    // glow (only slot 1). Only the primaries should be zeroed.
    const set = dyeSetFromGearDyes({
      "0": {
        primary: { emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { emissive: [0, 0, 0] },
      },
      "1": {
        primary: { emissive: [1, 0, 0], emissiveIntensity: 1 },
        secondary: { emissive: [0.9, 0.3, 0.1], emissiveIntensity: 1 },
      },
    });
    expect(set[0].primary.emissive.getHex()).toBe(0x000000);
    expect(set[1].primary.emissive.getHex()).toBe(0x000000);
    expect(set[1].secondary.emissive.r).toBeCloseTo(0.9);
  });

  it("leaves a single-slot item's emissive untouched (nothing to compare against)", () => {
    // With one slot there's no cross-slot uniformity to distinguish a lone
    // glow from a lone placeholder — preserve it.
    const set = dyeSetFromGearDyes({
      "0": { primary: { emissive: [1, 0, 0], emissiveIntensity: 1 } },
    });
    expect(set[0].primary.emissive.r).toBeCloseTo(1);
    expect(set[0].primary.emissiveIntensity).toBe(1);
  });

  it("preserves emissive when a slot has zero intensity (doesn't actually contribute)", () => {
    // Same colour across slots but one has intensity 0 → not 'all contribute'
    // → not the placeholder signature → left as-is.
    const set = dyeSetFromGearDyes({
      "0": { primary: { emissive: [1, 0, 0], emissiveIntensity: 1 } },
      "1": { primary: { emissive: [1, 0, 0], emissiveIntensity: 0 } },
    });
    expect(set[0].primary.emissive.r).toBeCloseTo(1);
    expect(set[0].primary.emissiveIntensity).toBe(1);
  });

  it("is a no-op on an empty set", () => {
    const empty: DyeSet = {};
    expect(() => neutralizePlaceholderEmissive(empty)).not.toThrow();
  });
});

describe("dyeSetFromGearDyes — defensive parsing", () => {
  it("tolerates missing tints and fields", () => {
    const set = dyeSetFromGearDyes({ "2": { cloth: true } });
    expect(set[2].cloth).toBe(true);
    expect(set[2].primary.albedo.r).toBe(1);
    expect(set[2].secondary.fuzz).toBe(0);
  });

  it("falls back detail normal transform to the diffuse transform", () => {
    const set = dyeSetFromGearDyes({
      "0": { detailDiffuseTransform: [3, 3, 0.1, 0.2] },
    });
    expect(set[0].detailNormalTransform).toEqual([3, 3, 0.1, 0.2]);
  });

  it("worn albedo falls back to the albedo itself", () => {
    const set = dyeSetFromGearDyes({
      "0": { primary: { albedo: [0.2, 0.4, 0.6] } },
    });
    expect(set[0].primary.wornAlbedo.g).toBeCloseTo(0.4);
  });

  it("carries materialTypeId through, defaulting to -1 (standard PBR) when absent", () => {
    // -1 is also what gearMaterial.ts's KNOWN_EMISSIVE_MATERIAL_TYPE_IDS
    // treats as "known" — so missing data never accidentally suppresses a
    // legitimate emissive glow.
    const withId = dyeSetFromGearDyes({
      "0": { primary: { materialTypeId: 4 } },
    });
    expect(withId[0].primary.materialTypeId).toBe(4);

    const withoutId = dyeSetFromGearDyes({ "0": { primary: { albedo: [1, 1, 1] } } });
    expect(withoutId[0].primary.materialTypeId).toBe(-1);
  });
});
