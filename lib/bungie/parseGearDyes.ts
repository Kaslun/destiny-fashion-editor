/** Pure parser for current and legacy mobile gear dye schemas. */
/** One tint (primary or secondary) of a dye slot — Bungie's full PBR set. */
export interface DyeTint {
  /** linear RGB albedo tint (0..1) */
  albedo: [number, number, number];
  /** albedo the surface takes in worn/scratched areas (gearstack wear mask) */
  wornAlbedo: [number, number, number];
  /** material_params[3] — 0 dielectric .. 1 metal */
  metalness: number;
  /** worn_material_parameters[3] — metalness of the worn state */
  wornMetalness: number;
  /** material_params[0] — detail-map blend strength 0..1 */
  detailBlend: number;
  detailNormalBlend: number;
  detailRoughnessBlend: number;
  wornDetailBlend: number;
  wornDetailNormalBlend: number;
  wornDetailRoughnessBlend: number;
  /** advanced[2]: wrapped diffuse / thin-surface transmission, not glass. */
  transmission: number;
  /** material_advanced_params[1] — fuzz (cloth) amount 0..1 */
  fuzz: number;
  /** Iridescence palette index (-1 = none); legacy wire field name. */
  materialTypeId: number;
  /** roughness_remap vec4 applied to the gearstack smoothness channel */
  roughnessRemap: [number, number, number, number];
  /** worn_roughness_remap vec4 — smoothness remap of the worn state */
  wornRoughnessRemap: [number, number, number, number];
  /** wear_remap vec4 applied to the gearstack wear signal */
  wearRemap: [number, number, number, number];
  /** emissive_tint_color_and_intensity_bias rgb */
  emissive: [number, number, number];
  /** emissive_tint_color_and_intensity_bias[3] */
  emissiveIntensity: number;
  /** subsurface_scattering_strength_and_emissive[0] (0 = none, the norm) */
  sss: number;
}

export interface SlotDye {
  /** Bungie's authoritative per-slot material flag: true = fabric/soft goods. */
  cloth: boolean;
  /** entry names of the tiled per-slot detail maps (inside the item's texture containers) */
  detailDiffuse: string | null;
  detailNormal: string | null;
  /** [scaleX, scaleY, offsetX, offsetY] tiling transform for the detail diffuse */
  detailDiffuseTransform: [number, number, number, number];
  /** separate tiling transform for the detail normal (often differs) */
  detailNormalTransform: [number, number, number, number];
  primary: DyeTint;
  secondary: DyeTint;
}

export type GearDyes = Record<number, SlotDye>;

export interface DyeChannel { channelHash: number; dyeHash: number }
export interface DyeTranslation {
  defaultDyes?: DyeChannel[];
  customDyes?: DyeChannel[];
  lockedDyes?: DyeChannel[];
}

/** A shader contains repeated slot indices for armor, weapons, ships, etc.
 * Match investment hashes to the target's channels before parsing those slots.
 * Array order is not a reliable material-family identifier.
 */
export function selectDyeChannels(
  dyes: unknown,
  shader: DyeTranslation,
  target: DyeTranslation,
): unknown[] {
  const entries = (block: DyeTranslation) => [
    ...(block.defaultDyes ?? []), ...(block.customDyes ?? []), ...(block.lockedDyes ?? []),
  ];
  const channels = new Set(entries(target).map((dye) => dye.channelHash));
  const hashes = new Set(entries(shader)
    .filter((dye) => channels.has(dye.channelHash)).map((dye) => dye.dyeHash));
  return Array.isArray(dyes) ? dyes.filter((dye) =>
    dye && typeof dye === "object" && hashes.has(Number(dye.investment_hash))) : [];
}

function rgb3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length >= 3
    ? [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])]
    : fallback;
}

function vec4(
  v: unknown,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  return Array.isArray(v) && v.length >= 4
    ? [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2]), num(v[3], fallback[3])]
    : fallback;
}

function num(v: unknown, fallback: number): number {
  const n = v == null || Array.isArray(v) ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** No-op remap: full input range mapped straight through. */
const IDENTITY_REMAP: [number, number, number, number] = [0, 1, 0, 1];

function parseTint(
  mp: Record<string, unknown>,
  prefix: "primary" | "secondary",
): DyeTint {
  const p = (name: string) => mp[`${prefix}_${name}`] ?? mp[name];
  const albedo = rgb3(p("albedo_tint"), [1, 1, 1]);
  const materialParams = vec4(p("material_params"), [0, 0, 0, 0]);
  const wornParams = vec4(p("worn_material_parameters"), materialParams);
  const advanced = vec4(p("material_advanced_params"), [-1, 0, 0, 0]);
  const emissive = vec4(
    mp[`${prefix}_emissive_tint_color_and_intensity_bias`] ??
      mp[`${prefix}_emissive_tint_color`] ??
      mp.emissive_tint_color_and_intensity_bias ?? mp.emissive_tint_color,
    [0, 0, 0, 0],
  );
  const sssVec = p("subsurface_scattering_strength_and_emissive");
  return {
    albedo,
    wornAlbedo: rgb3(p("worn_albedo_tint"), albedo),
    metalness: Math.max(0, Math.min(1, materialParams[3])),
    wornMetalness: Math.max(0, Math.min(1, wornParams[3])),
    detailBlend: Math.max(0, Math.min(1, materialParams[0])),
    // Normal amplitude is allowed above one (live cloth uses 1.5 and 2).
    detailNormalBlend: Math.max(0, materialParams[1]),
    detailRoughnessBlend: Math.max(0, Math.min(1, materialParams[2])),
    wornDetailBlend: Math.max(0, Math.min(1, wornParams[0])),
    wornDetailNormalBlend: Math.max(0, wornParams[1]),
    wornDetailRoughnessBlend: Math.max(0, Math.min(1, wornParams[2])),
    transmission: Math.max(0, Math.min(1, advanced[2])),
    fuzz: Math.max(0, Math.min(1, advanced[1])),
    materialTypeId: advanced[0],
    roughnessRemap: vec4(p("roughness_remap"), IDENTITY_REMAP),
    wornRoughnessRemap: vec4(
      p("worn_roughness_remap"),
      vec4(p("roughness_remap"), IDENTITY_REMAP),
    ),
    wearRemap: vec4(p("wear_remap"), [0, 0, 1, 0]),
    emissive: [emissive[0], emissive[1], emissive[2]],
    emissiveIntensity: num(emissive[3], 0),
    sss: Array.isArray(sssVec) && sssVec.length > 0 ? num(sssVec[0], 0) : 0,
  };
}

export function parseDyes(defaultDyes: unknown): GearDyes {
  const out: GearDyes = {};
  const dyes = (defaultDyes as {
    slot_type_index?: number;
    cloth?: boolean;
    material_properties?: Record<string, unknown>;
    textures?: Record<string, { name?: string } | undefined>;
  }[]) ?? [];
  for (const dye of Array.isArray(dyes) ? dyes : []) {
    if (!dye || typeof dye !== "object") continue;
    const slot = dye.slot_type_index ?? 0;
    if (!Number.isInteger(slot) || slot < 0) continue;
    if (out[slot]) continue; // first group wins
    const mp = dye.material_properties ?? {};
    const tx = dye.textures ?? {};
    const detailDiffuseTransform = vec4(mp.detail_diffuse_transform, [1, 1, 0, 0]);
    out[slot] = {
      cloth: dye.cloth === true,
      // Detail-map entry names live in the dye's texture container. The key
      // varies across dumps (`detail_diffuse`/`detail_normal` in current gear
      // files, `diffuse`/`normal` in some). Check both.
      detailDiffuse: tx.detail_diffuse?.name ?? tx.diffuse?.name ?? null,
      detailNormal: tx.detail_normal?.name ?? tx.normal?.name ?? null,
      detailDiffuseTransform,
      detailNormalTransform: vec4(mp.detail_normal_transform, detailDiffuseTransform),
      primary: parseTint(mp, "primary"),
      secondary: parseTint(mp, "secondary"),
    };
  }
  return out;
}

