import { expect, it } from "vitest";
import { collectShaderPlugs, equippedShader } from "./shaderPlugs";

it("resolves shader plugs independently of ornaments, retaining duplicate-name hashes", () => {
  const shader = { itemType: 19, plug: { plugCategoryIdentifier: "shader" },
    displayProperties: { name: "Same name", icon: "/common/icon.png" },
    translationBlock: { customDyes: [{ dyeHash: 123 }] } };
  const shaders = collectShaderPlugs({ a: { ...shader, hash: 10 }, b: { ...shader, hash: 11 },
    ornament: { ...shader, hash: 12, plug: { plugCategoryIdentifier: "armor_skins_hunter_chest" } },
    empty: { ...shader, hash: 13, translationBlock: {} },
    redacted: { ...shader, hash: 14, redacted: true } });
  expect(equippedShader([12, 11, 999], shaders)).toBe(11);
  expect(shaders[11].name).toBe("Same name");
  expect(shaders[11].icon).toContain("%2Fcommon%2Ficon.png");
  expect(equippedShader([13], shaders)).toBeNull();
  expect(equippedShader([], shaders)).toBeNull();
  expect(equippedShader([999, 14], shaders)).toBeNull();
  expect(Object.keys(shaders)).toHaveLength(2);
});
