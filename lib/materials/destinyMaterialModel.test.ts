import { describe, expect, it } from "vitest";
import { decodeGearstack, evaluateRemap, IDENTITY_REMAP, NO_WEAR_REMAP } from "./destinyMaterialModel";
import { parseDyes } from "../bungie/parseGearDyes";
import { dyeSetFromGearDyes } from "./gearDye";
import { createGearMaterials } from "./gearMaterial";
import * as THREE from "three/webgpu";
import corpus from "./fixtures/dye-corpus.json";

describe("D2 authored remap (same arithmetic as the TSL graph)", () => {
  it("preserves identity, including the endpoints", () => {
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(evaluateRemap(x, IDENTITY_REMAP)).toBeCloseTo(x);
  });
  it("keeps Nighthawk gold smoothness in its authored 0.74–0.89 band", () => {
    const gold = parseDyes(corpus.items[0].dyes)[0].primary;
    expect(evaluateRemap(0, gold.roughnessRemap)).toBeCloseTo(0.74);
    expect(evaluateRemap(1, gold.roughnessRemap)).toBeCloseTo(0.89);
    expect(evaluateRemap(0.86, gold.roughnessRemap)).toBeCloseTo(0.80000048);
  });
  it("supports constant cloth roughness and pristine surfaces without division by zero", () => {
    for (const x of [0, 0.5, 1]) {
      expect(evaluateRemap(x, [0, 0, 0.2, 0])).toBeCloseTo(0.2);
      expect(1 - evaluateRemap(x, NO_WEAR_REMAP)).toBe(0);
    }
  });
  it("preserves signed smoothness for fuzz instead of clipping to zero", () => {
    expect(evaluateRemap(0, [-1, 2, -1, 2])).toBe(-1);
    expect(evaluateRemap(1, [-1, 2, -1, 2])).toBe(1);
  });
  it("interprets the real wear ramp as worn-to-pristine", () => {
    const remap = parseDyes(corpus.items[0].dyes)[0].primary.wearRemap;
    expect(1 - evaluateRemap(0, remap)).toBe(1);
    expect(1 - evaluateRemap(1, remap)).toBe(0);
    expect(1 - evaluateRemap(0.8, remap)).toBeCloseTo(0.4652);
  });
});

describe("packed gearstack boundaries", () => {
  it("keeps alpha-test, emissive, undyed metal and dye/wear bands distinct", () => {
    expect(decodeGearstack([0, 0.5, 32 / 255, 32 / 255])).toMatchObject({
      ao: 0, smoothness: 0.5, opacity: 1, emissive: 0, metalness: 1, dyed: false, wearSignal: 0,
    });
    expect(decodeGearstack([1, 1, 40 / 255, 39 / 255]).dyed).toBe(false);
    expect(decodeGearstack([1, 1, 40 / 255, 40 / 255]).dyed).toBe(true);
    expect(decodeGearstack([1, 1, 1, 1])).toMatchObject({ emissive: 1, wearSignal: 1 });
    expect(decodeGearstack([1, 1, 0, 48 / 255])).toMatchObject({ opacity: 0, emissive: 0, wearSignal: 0 });
  });
});

describe("live mobile dye corpus captured 2026-09-22", () => {
  for (const item of corpus.items) {
    it(`preserves all six materials and builds ${item.name}`, () => {
      const parsed = parseDyes(item.dyes);
      const dyes = dyeSetFromGearDyes(parsed);
      for (const raw of item.dyes) {
        for (const parity of ["primary", "secondary"] as const) {
          const t = dyes[raw.slot_type_index][parity];
          const mp = raw.material_properties as Record<string, number[]>;
          expect(t.detailNormalBlend).toBe(mp[`${parity}_material_params`][1]);
          expect(t.detailRoughnessBlend).toBe(mp[`${parity}_material_params`][2]);
          expect(t.transmission).toBe(mp[`${parity}_material_advanced_params`][2]);
          expect(t.wornDetailNormalBlend).toBe(mp[`${parity}_worn_material_parameters`][1]);
          expect(t.materialTypeId).toBe(mp[`${parity}_material_advanced_params`][0]);
        }
      }
      const materials = createGearMaterials(
        Array.from({ length: 6 }, (_, dyeIndex) => ({ dyeIndex, decal: false })), dyes,
        { diffuse: new THREE.Texture(), normal: new THREE.Texture(), gearstack: new THREE.Texture() },
        { useGearstack: true, applyDye: true },
      ) as THREE.MeshSSSNodeMaterial[];
      for (const material of materials) {
        expect(material.colorNode).not.toBeNull();
        expect(material.normalNode).not.toBeNull();
        expect(material.userData.uniforms.uBandMode.value).toBe(3);
        material.dispose();
      }
    });
  }
  it("activates thin-surface transmission from advanced[2], with legacy SSS zero", () => {
    const dyes = dyeSetFromGearDyes(parseDyes(corpus.items[0].dyes));
    expect(dyes[1].primary.transmission).toBe(0.2);
    expect(dyes[1].primary.sss).toBe(0);
    const [material] = createGearMaterials([{ dyeIndex: 2, decal: false }], dyes,
      { diffuse: new THREE.Texture(), gearstack: new THREE.Texture() },
      { useGearstack: true, applyDye: true }) as THREE.MeshSSSNodeMaterial[];
    expect(material.useSSS).toBe(true);
  });
});

describe("legacy and incomplete gear data", () => {
  it("prefers an explicit per-tint emissive alias to a shared default", () => {
    const t = parseDyes([{ material_properties: {
      primary_emissive_tint_color: [0, 0, 0, 0],
      emissive_tint_color_and_intensity_bias: [1, 0, 0, 1],
    } }])[0];
    expect(t.primary.emissiveIntensity).toBe(0);
    expect(t.secondary.emissiveIntensity).toBe(1);
  });
  it("uses shared properties only when the corresponding per-tint field is absent", () => {
    const [slot] = Object.values(parseDyes([{ slot_type_index: 0, material_properties: {
      wear_remap: [-2, 3, 0, 1], worn_material_parameters: [0.2, 0.3, 0.4, 1],
      emissive_tint_color_and_intensity_bias: [0, 1, 0, 2],
      primary_emissive_tint_color_and_intensity_bias: [0, 0, 0, 0],
      primary_wear_remap: [0, 0, 1, 0],
    } }]));
    expect(slot.primary.emissiveIntensity).toBe(0);
    expect(slot.secondary.emissiveIntensity).toBe(2);
    expect(slot.primary.wearRemap).toEqual(NO_WEAR_REMAP);
    expect(slot.secondary.wearRemap).toEqual([-2, 3, 0, 1]);
    expect(slot.secondary.wornDetailNormalBlend).toBe(0.3);
  });
  it("rejects non-finite values and malformed containers", () => {
    expect(parseDyes({})).toEqual({});
    const dyes = parseDyes([null, { slot_type_index: 0, material_properties: {
      primary_material_params: [NaN, Infinity, 0.5, null],
    } }]);
    expect(dyes[0].primary.detailBlend).toBe(0);
    expect(dyes[0].primary.detailNormalBlend).toBe(0);
    expect(dyes[0].primary.detailRoughnessBlend).toBe(0.5);
    expect(dyes[0].primary.metalness).toBe(0);
  });
});
