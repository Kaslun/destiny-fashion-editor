import { describe, expect, it } from "vitest";
import { classifyTextureRole, pickBestByRole, type TexImage } from "./textureContainer";

describe("surface textures versus unbound effect resources", () => {
  it.each([
    "1031021746_vfx_energy_fracture_illum", // real Sage Protector shader input
    "2503085780_smoke_detail_warp",
    "shared_illumination_palette",
    "shared_glow_noise",
    "unbound_weapon_glow",
  ])("does not promote %s to whole-surface emission", (name) => {
    expect(classifyTextureRole(name)).toBe("other");
  });

  it("retains plated glow albedo and its packed masks as their declared roles", () => {
    for (const [suffix, role] of [["0", "diffuse"], ["1", "normal"], ["2", "gearstack"]] as const) {
      expect(classifyTextureRole(`armor_glow_gbit_512_512_${suffix}`)).toBe(role);
    }
    expect(classifyTextureRole("armor_glow_norm")).toBe("normal");
    expect(classifyTextureRole("armor_glow_dif")).toBe("diffuse");
  });

  it("cannot select a shared illumination effect from a pooled texture list", () => {
    const names = ["armor_gbit_512_512_0", "armor_gbit_512_512_2", "1031021746_vfx_energy_fracture_illum"];
    const images: TexImage[] = names.map((name) => ({ name, role: classifyTextureRole(name),
      bytes: new Uint8Array(), size: 1024, gbit: name.includes("gbit") }));
    expect(pickBestByRole(images, "emissive")).toBeNull();
    expect(pickBestByRole(images, "gearstack")?.name).toBe(names[1]);
  });
});
