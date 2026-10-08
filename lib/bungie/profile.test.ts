import { expect, it, vi } from "vitest";
vi.mock("./client", () => ({ bungieFetch: vi.fn() }));
vi.mock("./itemDefs", () => ({ getItemIndex: vi.fn() }));
import { bungieFetch } from "./client";
import { getItemIndex } from "./itemDefs";
import { getCharacterLoadouts } from "./profile";

it("imports the equipped shader without replacing ornament or owned item identities", async () => {
  vi.mocked(getItemIndex).mockResolvedValue({ version: "test", items: [], shaderPlugs: {
    99: { hash: 99, name: "Shader", icon: null, kind: "shader", slot: null, tier: "Legendary", classType: 3 },
  } });
  vi.mocked(bungieFetch).mockResolvedValueOnce({ destinyMemberships: [
    { membershipType: 3, membershipId: "member", crossSaveOverride: 0 },
  ] }).mockResolvedValueOnce({
    characters: { data: { guardian: { classType: 1, light: 2000 } } },
    characterEquipment: { data: { guardian: { items: [
      { itemHash: 1, itemInstanceId: "instance", bucketHash: 14239492, overrideStyleItemHash: 2 },
      { itemHash: 3, itemInstanceId: "empty", bucketHash: 3448274439 },
    ] } } },
    itemComponents: { sockets: { data: {
      instance: { sockets: [{ plugHash: 2 }, { plugHash: 99 }, { plugHash: 1000 }] },
      empty: { sockets: [{ plugHash: 1000 }, {}] },
    } } },
  });
  const [character] = await getCharacterLoadouts("synthetic-token");
  expect(character.items[0]).toMatchObject({ itemHash: 1, ornamentHash: 2, shaderHash: 99 });
  expect(character.items[1]).toMatchObject({ itemHash: 3, ornamentHash: null, shaderHash: null });
});
