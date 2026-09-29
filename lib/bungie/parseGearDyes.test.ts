import { describe, expect, it } from "vitest";
import { parseDyes, selectDyeChannels } from "./parseGearDyes";

describe("shader investment channel selection", () => {
  // Current Photo Finish mappings; repeated slot 0 is not the same surface.
  const families = [
    [662199250, 3765091281], [1667433279, 1539940406],
    [3073305669, 1410914284], [1971582085, 2961482178], [373026848, 291897147],
  ];
  const shader = { defaultDyes: families.map(([channelHash, dyeHash]) => ({ channelHash, dyeHash })) };
  const dyes = families.map(([, investment_hash], index) => ({
    investment_hash, slot_type_index: 0,
    material_properties: { primary_albedo_tint: [index / 5, 0, 0, 1] },
  }));
  it.each(families)("selects channel %i without relying on array order", (channelHash, dyeHash) => {
    const target = { defaultDyes: [{ channelHash, dyeHash: 123 }] };
    const selected = selectDyeChannels([...dyes].reverse(), shader, target);
    expect(selected).toEqual(dyes.filter((dye) => dye.investment_hash === dyeHash));
    expect(Object.keys(parseDyes(selected))).toEqual(["0"]);
  });
  it("includes locked and custom channels and never guesses an absent family", () => {
    const target = { lockedDyes: [shader.defaultDyes[1]], customDyes: [shader.defaultDyes[4]] };
    expect(selectDyeChannels(dyes, shader, target)).toEqual([dyes[1], dyes[4]]);
    expect(selectDyeChannels(dyes, shader, {})).toEqual([]);
    expect(selectDyeChannels(null, shader, target)).toEqual([]);
  });
});
