/**
 * Some Hunter helmets hide the equipped cloak's hood in-game. Bungie exposes
 * no data flag for this anywhere in the public API (checked: item definition,
 * gear/dye render content, item categories, traits, Collections presentation
 * metadata) — it's almost certainly a client-side effect, not data. So this
 * is a hand-maintained list of helmet item hashes, keyed to the one piece of
 * this that IS data-driven: every cloak's hood ships as its own rigid,
 * unskinned geometry file at index 0, separate from the skinned cape body
 * (confirmed on Memory of Cayde Cloak, 625602056). See `hideHood` in
 * lib/loader/loadGearModel.ts for the render-side toggle.
 *
 * No common data trigger was found even across this confirmed list: all are
 * `itemType: 19` universal-ornament plugs (`equippable: false`, bucket
 * 3313201758/2422292810) — but that description also matches hundreds of
 * OTHER Hunter head ornaments that do NOT hide the hood, so itemType/bucket/
 * plugCategoryIdentifier/traits can't distinguish this set on their own.
 */

/** Individually named, user-confirmed hood-hiding helmets. */
const NAMED_HOOD_HIDING_HELMETS = new Set<number>([
  1379845313, // Omnioculus Mask
  3912040564, // Couturier Mask
  1400258673, // Thy Fearful Symmetry
  2086582259, // The Rat King's Crown
  2385145063, // Navigator's Crown
  2712582686, // Unobjective
  3044905, // Chromacloak Visage
  1784694924, // Blanka Helmet Pack
  4146568778, // Totembreaker's Mask
  552643521, // Velocity Helmet
]);

/**
 * Festival of the Lost mask ornaments (fit the Masquerader's Cowl's shared
 * mask socket, `plugCategoryIdentifier: "armor_skins_shared_head"`). Bulk
 * added per "most of the Festival of the Lost masks" — this is the full 2025
 * roster from `DestinyPlugSetDefinition` 3296801775; prune any that turn out
 * NOT to hide the hood.
 */
const FESTIVAL_OF_THE_LOST_MASKS = new Set<number>([
  2883258894, // Failsafe Mask
  2883258881, // Grim Mask
  2883258880, // Oryx Mask
  2883258883, // Lodi Mask
  2883258882, // Orin Mask
  2883258885, // Fungal Mask
  444302065, // Weasel Error Mask
  444302066, // Spicy Ramen Mask
  444302067, // Drop Pod Mask
  1460790372, // Nezarec Mask
  1460790373, // Runner Mask
  1460790370, // Finalized Ghost
  1460790371, // Tower Staff Mask
  1460790368, // Kadi 55-30 Mask
  1460790369, // Cursed Thrall Mask
  1067975723, // Witness Mask
  1067975722, // Cayde-6 Mask
  1808095282, // Pouka Mask
  1808095283, // Tormentor Mask
  1808095284, // Calus Mask
  1808095285, // Nimbus Mask
  1808095286, // Mara Sov Mask
  1808095287, // Clovis Bray Mask
  1971240964, // Disciple Mask
  1971240965, // Good Boy Mask
  1844904396, // Savathûn Mask
  1844904397, // Riven Mask
  1844904398, // Caiatl Mask
  1844904399, // Bread Mask
  1844904392, // Telesto Mask
  1844904393, // Blueberry Mask
  494187469, // Fynch Mask
  494187468, // Starhorse Mask
  1912138920, // Eramis Mask
  1912138921, // Taniks Mask
  1912138922, // Honk Moon Mask
  1912138923, // Pyramid Mask
  1912138924, // Ada-1 Mask
  1912138925, // Sweeper Bot Mask
  3727346032, // Penguin Mask
  3727346033, // Shaded Titan Mask
  1691825973, // Bubbling Mask
  1691825972, // Fractured Traveler Mask
  1691825975, // Variks Mask
  1691825974, // Exo Stranger Mask
  1691825969, // Ana Bray Mask
  1691825968, // Wrapped Traveler Mask
  3326837142, // Associates Mask
  3326837143, // Spider Mask
  1494882402, // Opulent Calus Mask
  1494882403, // Mithrax Mask
  1494882400, // Hidden Swarm Mask
  1494882401, // Goblin Mask
  1494882406, // Drifter Mask
  1494882407, // Eris Morn Mask
  1201782503, // Omnigul Mask
  1201782502, // Jack-o'-Lantern Mask
  3222576964, // Traveler Mask
  3222576965, // Dark Prince Mask
  3222576966, // Master Rahool Mask
  3222576967, // Petra Venj Mask
  3222576960, // Lord Shaxx Mask
  3222576961, // Dominus Ghaul Mask
  3222576962, // Emperor Calus Mask
  3222576963, // Will of the Thousands Mask
  3222576972, // Scorn Mask
  3222576973, // Jade Rabbit Mask
  3328375333, // Glitterball Mask
  3328375332, // Colonel Mask
]);

/** Hunter helmet item hashes known to hide the equipped cloak's hood. */
export const HOOD_HIDING_HELMETS = new Set<number>([
  ...NAMED_HOOD_HIDING_HELMETS,
  ...FESTIVAL_OF_THE_LOST_MASKS,
]);

export function helmetHidesHood(helmetHash: number | null | undefined): boolean {
  return helmetHash != null && HOOD_HIDING_HELMETS.has(helmetHash);
}
