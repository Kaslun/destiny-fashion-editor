/**
 * Player profile → equipped loadout.
 *
 * Resolves the signed-in user's Destiny membership, then pulls their characters
 * and equipped gear (with applied ornaments + socket plugs, so we can render the
 * transmogged appearance, not just the base items).
 */
import { bungieFetch } from "./client";

/** DestinyInventoryBucket hashes → our editor slot keys. */
const BUCKET_SLOT: Record<number, string> = {
  3448274439: "helmet",
  3551918588: "gauntlets",
  14239492: "chest",
  20886954: "legs",
  1585787867: "classItem",
  1498876634: "kinetic",
  2465295065: "energy",
  953998645: "power",
};

const CLASS_NAME: Record<number, string> = { 0: "Titan", 1: "Hunter", 2: "Warlock" };

export interface EquippedItem {
  slot: string;
  bucketHash: number;
  itemHash: number;
  /** applied ornament (transmog appearance), if any — render THIS geometry. */
  ornamentHash: number | null;
  instanceId: string | null;
  /** socket plug hashes (used to resolve the applied shader). */
  plugHashes: number[];
}

export interface CharacterLoadout {
  characterId: string;
  classType: number;
  className: string;
  emblemPath: string | null;
  light: number;
  items: EquippedItem[];
}

interface DestinyMembership {
  membershipType: number;
  membershipId: string;
  crossSaveOverride: number;
}

interface MembershipsResponse {
  destinyMemberships: DestinyMembership[];
  primaryMembershipId?: string;
}

interface ProfileResponse {
  characters?: {
    data?: Record<
      string,
      { classType: number; emblemPath?: string; light: number; dateLastPlayed: string }
    >;
  };
  characterEquipment?: {
    data?: Record<
      string,
      {
        items: {
          itemHash: number;
          itemInstanceId?: string;
          bucketHash: number;
          overrideStyleItemHash?: number;
        }[];
      }
    >;
  };
  itemComponents?: {
    sockets?: {
      data?: Record<string, { sockets: { plugHash?: number }[] }>;
    };
  };
}

/** Resolve the active Destiny membership (respecting cross-save). */
async function getDestinyMembership(token: string): Promise<DestinyMembership> {
  const r = await bungieFetch<MembershipsResponse>(
    "/User/GetMembershipsForCurrentUser/",
    { accessToken: token },
  );
  const list = r.destinyMemberships ?? [];
  if (list.length === 0) throw new Error("No Destiny 2 account on this Bungie profile.");
  if (r.primaryMembershipId) {
    const primary = list.find((m) => m.membershipId === r.primaryMembershipId);
    if (primary) return primary;
  }
  // Cross-save: the active platform's override points at its own type.
  const active = list.find(
    (m) => m.crossSaveOverride !== 0 && m.crossSaveOverride === m.membershipType,
  );
  return active ?? list[0];
}

/** All characters on the account with their equipped loadouts. */
export async function getCharacterLoadouts(token: string): Promise<CharacterLoadout[]> {
  const m = await getDestinyMembership(token);
  const profile = await bungieFetch<ProfileResponse>(
    `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/?components=200,205,305`,
    { accessToken: token },
  );

  const chars = profile.characters?.data ?? {};
  const equip = profile.characterEquipment?.data ?? {};
  const socketData = profile.itemComponents?.sockets?.data ?? {};

  const loadouts: CharacterLoadout[] = [];
  for (const [characterId, char] of Object.entries(chars)) {
    const items: EquippedItem[] = [];
    for (const it of equip[characterId]?.items ?? []) {
      const slot = BUCKET_SLOT[it.bucketHash];
      if (!slot) continue; // skip ghost/ship/emblem/subclass/etc.
      const plugHashes =
        (it.itemInstanceId && socketData[it.itemInstanceId]?.sockets
          ? socketData[it.itemInstanceId].sockets
              .map((s) => s.plugHash ?? 0)
              .filter((h) => h > 0)
          : []) ?? [];
      items.push({
        slot,
        bucketHash: it.bucketHash,
        itemHash: it.itemHash,
        ornamentHash: it.overrideStyleItemHash ?? null,
        instanceId: it.itemInstanceId ?? null,
        plugHashes,
      });
    }
    loadouts.push({
      characterId,
      classType: char.classType,
      className: CLASS_NAME[char.classType] ?? "Guardian",
      emblemPath: char.emblemPath ?? null,
      light: char.light,
      items,
    });
  }
  // Most-recently-played first.
  return loadouts;
}
