# Destiny 2 material implementation

Updated 2026-09-30 against live mobile manifest
`244213.26.06.29.2000-1-bnet.65864`.

This renderer consumes Bungie's **mobile gear exports**, not the game's compiled
shaders. It implements the exported material parameters using Three.js lighting.
It cannot claim pixel-identical reproduction of every current game effect.

## References and evidence

- Bungie, [Translating Art into Technology: Physically Inspired Shading in Destiny 2](https://media.gdcvault.com/gdc2018/presentations/Haraux_Alexis_Hawbaker_Nate_Translating_Art_Into_Technology.pdf),
  GDC 2018. Slides 37–60 describe metalness, albedo, smoothness, transmission,
  iridescence, fuzz and emission (MASTIFE). Slides 119–129 describe **gearstack**
  packing. The deferred G-buffer packing on slide 62 is a different encoding;
  its exponential emissive curve must not be applied to gearstack B.
- Bungie, [This Week in Destiny, May 2, 2024](https://www.bungie.net/7/en/News/Article/twid-05-02-2024):
  six shader colors and updated icons. Six colors are not evidence that wear
  alpha contains six equal material-ID bands.
- [Spasm-to-Three TGX loader](https://github.com/lowlines/destiny-tgx-loader/blob/master/src/three.tgxloader.js):
  `parseStagePart` resolves the three primary/secondary pairs from draw calls;
  detail coordinates use TEXCOORD2.
- [Destiny Collada Generator shader reconstruction](https://github.com/TiredHobgoblin/Destiny-Collada-Generator/blob/b5e57d106d133b46a731c2be3a9312e270e5e1e4/Resources/template.shader)
  and [parameter definitions](https://github.com/TiredHobgoblin/Destiny-Collada-Generator/blob/b5e57d106d133b46a731c2be3a9312e270e5e1e4/Shaders.cs).
  This is independent reverse engineering, **not Bungie's source**. Its remap
  equation is corroborated by the current exports' constant and narrow-range
  vectors. The blend and normal reconstruction remain approximations.
- [Destiny Collada Generator geometry export](https://github.com/TiredHobgoblin/Destiny-Collada-Generator/blob/Main/WriteCOLLADA.cs),
  D2 triangle-strip path: `normal0_raw[6] & 0x7` supplies the vertex dye ID.
  Verified against both Cover of the Exile variants, Sixth Coyote and Relativism.
- [Bungie API issue 422](https://github.com/Bungie-net/api/issues/422) records the
  distinction between game shading and the incompletely documented web export.
- Bungie's [3D content documentation](https://github.com/Bungie-net/api/wiki/3D-Content-Documentation)
  documents draw stages and dye precedence; the current manifest's
  `translationBlock` associates investment dye hashes with material channels.
- `SHADER-DEBUG-SWEEP.md` is historical evidence of renderer problems, not a
  specification. Its claims about remap modes, material IDs and inferred bands
  are superseded here.

## Material families

| Family | Exported controls | Renderer behavior |
| --- | --- | --- |
| Metals, polished metal | Metalness and remapped smoothness | GGX physical lighting, authored tint, worn metalness |
| Paint, plastic, rubber, leather, ceramic | Dielectric metalness, tint, smoothness and detail | Same physical model; no item-name classification or forced metal gloss |
| Coated / weathered surfaces | Worn tint, metalness, smoothness and detail blend triplet | Coating transitions to the separately authored worn material |
| Cloth, velvet, fur | Fuzz and signed smoothness | Three's sheen approximation; negative smoothness still activates the cloth path |
| Thin fabric / translucent surfaces | Advanced parameter 2 and legacy SSS | Wrapped/backlit SSS approximation, suppressed on metallic and undyed pixels; this is not glass refraction |
| Emissive surfaces | Gearstack B and tint/intensity; optional illumination map | No iridescence-ID whitelist or global duplicate-color suppression |
| Iridescent metal / dielectric | Advanced parameter 0: palette index | Reference lookup palette; even rows tint metallic reflection, odd rows tint dielectric specular; PBR approximation |
| Animated patterns and darkness accents | Recognized static texture sets | Existing texture-driven previews retained and marked approximate in material diagnostics |
| Transparent ray glow | Stage 7, shader 8, godray-height and wispy-smoke textures | Soft animated additive ribbons with authored emissive tint; no lighting or depth writes; approximate effect shader |
| Digital cloud / particle cards | Stage 7, shader 8, stain palette + digital cloud + dust/snow mask | Authored gearstack-B symbol coverage, additive light, approximate animated brightness; no depth writes |
| Ability-dependent VFX | Existing confirmed item/geometry opt-in | Existing toggle/flicker approximation retained; no new universal flag guesses |
| Decals and cutout surfaces | Investment-decal slots and per-pass metadata | Decal tint isolation retained. A generic alpha-test flag remains unresolved; see limits below |

## Transparent ray effects — 2026-09-28

Entheogenic Parasite Vest (`959073698`) separates its armor (stage 0, shader 7)
from 84 ray-carrier triangles (stage 7, shader 8) in both mobile body variants.
The latter explicitly reference `3107841013_vfx_godray_a_height` and
`4137719177_smoke_soft_wispy_plate`. Bungie's render-stage documentation above
identifies stage 7 as transparent effects. Treating this draw as ordinary armor
exposed large solid cyan polygons and sampled the armor atlas instead of these
effect textures.

The renderer now recognizes this complete stage/shader/texture signature,
loads the referenced textures by exact name, and uses an unlit additive pass
with depth testing enabled and depth writes disabled. It preserves the draw's
primary/secondary emissive tint and intensity, including shader overrides.
Packed normal material IDs are only decoded for opaque/legacy draws, not for
transparent VFX, whose auxiliary vertex data may have another meaning.

The exported UVs place 14 disconnected, eight-vertex ribbons in very small
atlas islands. The preview normalizes each connected island independently into
local effect coordinates while preserving armor UVs and geometry. Soft edge
and length fades and scrolling textures are approximations: the mobile export
does not provide the game's full effect program, animation constants or blend
state. It is not a reconstruction of every stage-7 effect or a bloom simulation.
Missing effect textures or unusable coordinates hide the carriers instead of
falling back to solid armor. A runtime warning identifies the approximation.
`lib/geometry/fixtures/entheogenic-rays.json` retains the real effect vertex
bytes and draw metadata for both variants, with unused vertices removed and
indices remapped for a compact regression fixture.

### Shared transparent-effect routing and Spacewalk Vest

Spacewalk Vest (`2041120767`) exposed the same opaque fallback through a different
effect family. Both variants contain a stage-7/shader-8 LOD01 draw with four
triangles, forming two separately packed UV cards. It references
`2846779858_taken_stain_etch_palette`, `1363171116_digital_cloud_plate`, and
`4137719177_dust_snow_mask_med01`. These textures contain grayscale palette,
digital density and particle coverage data; their alpha is uniformly opaque.
Its armor dyes have zero emission, so neither dye emission nor texture alpha
alone can recover this effect.

`transparentEffects.ts` routes supported effects by complete texture signatures
and resolves their textures by exact name. On 2026-09-29, tracing both cards'
original atlas UVs revealed **two distinct symbols in gearstack B**: the left
chest and left hip. The earlier generic cloud preview discarded these masks and
multiplied several dim textures, so removing the solid carriers did not recover
the intended effect.

The corrected path decodes `(B - 40/255) / (1 - 40/255)` at the original atlas UV,
clamped to 0�1, as coverage. Cloud, dust and palette textures only vary brightness
inside that shape. Local per-card UVs are used for animation, never the symbol
mask. Additive unlit shading preserves the luminous appearance. Missing animation
textures retain static symbols; missing gearstack hides the carrier. A positive
authored emissive dye supplies color when available; otherwise this program uses a reference-calibrated violet tint (see September 30
below). Timing, intensity and that fallback tint remain approximations.
No item hash selects this behavior.

Both body variants are preserved in `fixtures/spacewalk-effects.json`; the raw
RGBA gearstack tile is `fixtures/spacewalk-gearstack.png` (source texture
`4252046389_hun_bray_exosuit_chest_gbit_512_256_2`, retrieved 2026-09-29). It is
512x256, placed at (0,256) in a 512x512 atlas. Hip bounds are (72,103)�(109,155)
and chest bounds (349,111)�(399,137) in tile pixels. The regression samples those
regions using real geometry UVs and checks their distinct emissive coverage.

Approximation details appear under **Rendering notes**, separate from failures.

After recognized effects and the existing ability preview, unrecognized stage-7
draws are hidden with an explicit warning and diagnostic metadata. They no
longer fall back to solid armor. This avoids visible carrier polygons but does
**not** mean those unknown effects have been reconstructed. Opaque and decal
passes retain their existing material handling.

## Shared emission and bloom � 2026-09-30

The user supplied an in-game Spacewalk Vest image showing near-white symbol
centers with violet/blue halos, plus lit shell indicators on the torso and belt.
The earlier white silhouettes lacked both a color constant and bloom. A fresh
inspection found **all** Spacewalk dye emission fields zero (legacy, shared and
primary/secondary forms, including `emissive_pbr_params`); reinterpreting a zero
bias cannot recover the missing color. No emission parser semantics were changed.

`EmissionBloom` now renders a half-float emissive attachment in the shared viewer
used by both `/poc` and the editor. It blurs emitted light only, combining it with
the beauty render before tone mapping. White paint, metal reflections and the
reference grid do not become bloom sources. Unlit symbol and ray materials
explicitly write their light to that attachment. Its blend mode inherits each
material's mode: otherwise transparent carriers incorrectly bloom as rectangles.
Depth testing and alpha coverage are retained. Raw material debug views bypass
blur/compositing while retaining the same render attachments; resizing is handled by the render pass, and its targets and
materials are disposed on unmount.

The approach follows Three's [emissive bloom example for r185](https://github.com/mrdoob/three.js/blob/r185/examples/webgpu_postprocessing_bloom_emissive.html)
and the installed `BloomNode`, `MRTNode` and `RenderPipeline` implementation.
Bloom strength/radius and the effect's missing color are preview calibration,
not extracted Tiger shader constants. The canvas retains transparent coverage
outside the model while allowing the halo to extend beyond its silhouette.

`effectEmissionFallback` supplies linear RGB (0.3, 0.2, 1), intensity 4, only to
meshes containing the complete stage-7/shader-8 digital-hologram texture signature.
This estimate is informed by the supplied game reference and marked in Rendering
notes. An explicit nonzero dye emission takes precedence. Gearstack B still
provides all coverage, including small lights on the opaque shell; diffuse color
and metalness never infer where something emits. Unrelated zero-emission surfaces
retain zero emission. Matching is by program evidence, not item hash or name.
The fallback is not proof that all shaders or all uses of these textures have
identical in-game color, and can be superseded when richer export data is found.

Live geometry confirmed this same program on Spacewalk Plate (`1615763427`) and
Robes (`480133716`), as well as Vest (`2041120767`). Spacewalk Cowl (`283230886`)
has no such draw. Entheogenic Parasite Vest (`959073698`) retains its authored
cyan ray tint and benefits from shared bloom without the violet estimate.
`lib/materials/fixtures/emission-programs.json` preserves their original stage
records for program recognition and isolation tests.

## Surface binding versus VFX textures � 2026-09-30

Sage Protector Vest (`1867581826`) exposed an older loader error. Its six authored
material indices are all -1 (no iridescence), and its fabric metalness is zero.
The shader references `1031021746_vfx_energy_fracture_illum` together with
`2503085780_smoke_detail_warp`. The loader classified any name containing `illum`
or `glow` as a standalone emission map, chose the largest such image from pooled
containers, and sampled it over the entire garment. This created a false colored
finish; adding bloom made the erroneous emission even more visible.

Both plated and direct-texture loading now stop assigning emission from these
name guesses. Texture names do not establish surface UV bindings. These shared
resources remain available to effect programs by exact name; their presence
never adds light to ordinary cloth. Numeric plate roles still take precedence,
including actual glow geometry's diffuse plate cells. Gearstack-B emission,
authored dye colors, bound glow plates and the supported transparent programs
remain active. The material API still accepts an explicitly supplied emission
map, but the loader cannot invent its binding from filenames or pooled images.

This change contains no item-specific exclusion and does not disable valid
iridescence palettes. Tests retain Sage Protector's raw dye records and reject
unbound illumination/palette/noise resources while preserving plate-map roles.

## Parameter semantics

`material_params = [diffuseDetail, normalDetail, roughnessDetail, metalness]`.
The worn material supplies its own triplet and metalness. Normal strength is
**not capped at one**: Cover of the Exile uses 1.5 and Gambit Jadestone uses 2.

`material_advanced_params = [iridescenceIndex, fuzz, transmission, reserved]`.
The wire property `materialTypeId` is retained for compatibility, but is no
longer interpreted as a material-family enum or emissive permission list.

The default remap is:

```text
remap(x, r) = clamp(x * r.y + r.x, r.z, r.z + r.w)
```

The remapped wear value is the **surviving coating**. Thus worn contribution is
`1 - remap(wearSignal)`. `[0,0,1,0]` preserves the original finish at every input;
`[0,0,0.2,0]` gives constant 0.2 smoothness. Nighthawk's gold remap
`[-4.933334,6.666668,0.74,0.15]` spans 0.74–0.89, not 0.15–0.74.

The parser accepts primary/secondary fields and older shared-field fallbacks,
preserves explicit zeroes, and merges custom dyes over defaults. Locked dyes
still win over an applied shader. Repeated emissive colors remain authored data;
equality alone does not establish a placeholder.

Applied shaders are filtered by the target item's manifest channels before
resolving repeated slot indices. This selects armor, weapon, ship, sparrow and
Ghost dye families without depending on their order in a shader's gear file.
Missing channel matches produce a warning and preserve the item's own dyes.

Gearstack is non-color data: R is AO, G smoothness, B packs opacity over 0–32
and emission over 40–255, A packs undyed metalness over 0–32, the dye step at
40, and wear over 48–255 (byte units). These ranges now have regression tests.

Atlas diffuse and detail diffuse RGB are sRGB-decoded once. Detail alpha is
linear roughness data; normal and gearstack textures are never gamma-decoded.
Normal Z is reconstructed from XY. Detail textures and their transforms follow
the selected dye slot; shader-owned textures are resolved from the applied
shader's containers as well as the item's. TEXCOORD2 becomes Three's `uv1`;
mobile exports without it use atlas UVs as an explicit approximation.

The default dye assignment uses packed vertex IDs for D2 short4-normal strips,
with stage-part indices as the fallback. Indices 0–5 select slot and parity.
An authored dyeslot texture overrides that assignment where it is active,
including primary/secondary selection. Its color flags are categorical IDs.
Investment decals remain undyed even when a dyeslot plate exists. Missing dye
slots retain their baked texture. The old A-band experiments and remap
interpretations remain available in the debug panel, labeled as legacy and
disabled by default. Wear, brightness and saturation no longer guess a slot.

## Material separation update — 2026-09-23

- Material PNG channels are decoded losslessly before atlas assembly. Canvas
  alpha compositing previously erased RGB at alpha zero and quantized low-alpha
  values. In gearstack those pixels carry valid undyed material data, not image
  transparency. Non-color atlas tiles now copy bytes without blending.
- Dye eligibility, undyed metalness and wear classification sample the same
  unfiltered level-zero alpha texel. Bilinear/mip interpolation of these packed
  classes could turn a dielectric/cloth boundary into a false metallic band.
  Continuous lighting channels still use filtered textures. Mask edge resolution
  remains limited by the exported texture resolution.
- Draw selection now follows `stage_part_offsets`: visible stages 0, 1, 2, 6
  and 7 stay separate from shadow/depth copies. Bit `0x8` does **not** establish
  a decal: Relativism and Sixth Coyote use it on ordinary stage-zero surfaces.
  LOD categories 0–3 all include LOD zero; choosing only the smallest enum lost
  valid parts. Duplicate index ranges within one pass keep their first record.
  Explicit stage-six overlays retain additive blending without making ordinary
  flagged surfaces additive.
- Unknown dye indices remain unassigned. They no longer inherit slot-zero tint
  or another slot's emission. Glow-region detection splits whole triangles,
  rather than applying an additive material to a mixed group by majority vote.
- `lib/geometry/fixtures/material-parts.json` preserves the real pass/LOD/dye
  records for Cover of the Exile, Relativism (shell and cloth), and Sixth Coyote.
  Regression tests exercise these alongside lossless PNG decoding and atlas
  placement. The preview's **resolved metalness** channel shows the final result.

## Alpha-guided boundary reconstruction — 2026-09-23

The original alpha is decoded into dye eligibility, undyed metalness and wear.
It is not divided into guessed cloth/metal dye IDs. Where a diffuse tile has
higher resolution than its gearstack tile, the loader now reconstructs the
material map at that resolution using four local source samples:

- A strong diffuse match needs a corroborating smoothness difference or normal
  detail edge. Conflicting normals reject the estimate; color alone cannot
  establish a new material. Deep AO, cutouts and emission are excluded from
  estimated boundary moves.
- Compatible samples interpolate continuous wear and smoothness inside their
  region. Dye/undyed classes, broad undyed metalness regions and blue's packed
  opacity/emission ranges never interpolate into each other. Sharp wear edges
  retain their local source value.
- Each atlas tile is processed independently. Unmatched or equal-resolution
  tiles retain source data; failure to reconstruct a complete atlas keeps the
  original map. No item names or applied-shader colors drive the estimates.
- The shader samples reconstructed alpha, smoothness and emission together.
  Raw source channels remain available in the inspector. **Decoded alpha**
  shows its actual signals; **estimated boundaries** highlights changed alpha
  classes. Metadata reports the reconstructed tile and estimated texel counts.

This is conservative edge reconstruction, not recovery of dye-slot IDs.
It preserves geometry dye assignment, primary/secondary selection and locked
dyes. Its thresholds are empirical safeguards, not newly discovered game
encoding. In particular, matching a color or a high alpha value does not prove
that a surface is metal, leather or fabric.

## Packed vertex material assignments — 2026-09-25

The previous conclusion that Cover of the Exile lacked material partitions was
incorrect: its single draw-call dye index is only a fallback. The three low bits
of raw `normal.w` identify the actual material on D2 mobile triangle strips.
Read the bits before SNORM normalization; neither zero nor an unset high bit
means missing data. Cover's tube uses both `0x0004` and `0x800c` across variants.

The loader buckets whole triangles by this ID inside each original draw pass,
preserving winding, strip restarts, LOD selection, flags and texture references.
Conflicting vertex IDs retain the draw-call assignment. Triangle lists,
float normals and overlays retain their existing assignments; the reference
does not establish the same encoding for those formats. No ID interpolation,
alpha thresholds or item-specific overrides are involved.

Both Cover variants resolve to 2,052 triangles in primary slot 0 (gold metal),
332 in secondary slot 1 (cloth), and 278 in primary slot 2 (black tube).
Sixth Coyote resolves to all six IDs across its 6,630 triangles. Relativism's
shell remains primary slot 0, while its float-normal cloth keeps slot 1 from
its draw calls. Alpha still controls dye eligibility, undyed metalness and wear
within those material regions; G supplies their smoothness variation.

`lib/geometry/fixtures/vertex-materials.json` retains source normal.w words and
index buffers for both mask variants, Sixth Coyote and Relativism's shell.
The geometry tests check every triangle's assignment against those raw words.
Preview metadata now reports resolved IDs, their source and triangle counts.

## Texture material assignments — 2026-09-28

Iron Companion Plate (`735535272`) uses a different export path: its draw calls
and packed normal.w all select ID 0, and a `dyeslot` plate supplies per-pixel
overrides. The reference exporter's `WriteCOLLADA.cs` divides the reported
dyeslot canvas dimensions by four while leaving placement coordinates/sizes
unchanged. Its `template.shader` tests source RGB and A against 0.5. These are
two separate details; neither RGB blend weights nor vertex IDs alone decode it.

The loader now assembles that quarter-resolution canvas and decodes RGB flags
to change-color IDs before uploading a nearest-sampled, non-mipmapped data map:
red/magenta = 1, green = 2, yellow = 3, blue/cyan = 4, white = 5.
Black and alpha <= 0.5 retain the geometry's ID, including its parity. Blank
atlas space also falls back. Dye eligibility and wear still come from gearstack
alpha. Unsupported placement extents warn and fall back instead of clipping
the map into a misleading material split.

The map takes precedence in the default authored mode as well as the comparison
modes. Each pixel selects one complete material row and its matching detail
textures; colors, metalness and fabric parameters are not blended across IDs.
Investment-decal IDs remain undyed. No item hash or assumed release year selects
the decoding path: the supplied geometry format and texture metadata do.

The earlier interpretation of Relativism's small `_3` map as a misplaced icon
was incorrect. Its small size reflects this atlas convention; black preserves
the existing geometry material instead of declaring an undyed region.
`lib/geometry/fixtures/iron-dye-map.json` retains Iron Companion Plate's raw PNG
and plate records for regression checks. Its 128x64 tile occupies the upper
half of a 128x128 dye canvas, matching the other maps' normalized coordinates.
The exported map's low resolution remains visible at some material edges.

## Remaining fidelity limits

- **Iridescence**: the loader now supplies the reference exporter's 64x128
  lookup from `public/textures/iridescence-lookup.png`; source revision and credit
  are recorded beside it. Index zero is valid and -1 disables the effect. PNG row
  zero is index zero (the reference shader's inverted V is a texture convention).
  Alpha remains independent of RGB and unused zero-alpha rows do not contribute.
  Even indices blend metallic color/metalness; odd indices blend dielectric
  specular color. This approximates the reference in Three's PBR model, not Tiger's
  complete energy model. The reference palette's coverage of all current game
  presets is unverified. Only a failed resource load is reported as a warning;
  the former blanket missing-palette warning is no longer emitted.
- **Animation**: Photo Finish and other special shader animations require timing,
  palette/program data not present in the consumed mobile dye fields. Their
  static material parameters load, but their complete game animation is not
  reproduced. Relativism's pattern/darkness previews remain empirical, including
  the existing uncertainty about its default emissive values.
- **Alpha testing**: the B-channel opacity range is known, but a verified general
  draw-pass enable flag is not. Applying it to every opaque surface removes real
  geometry (including the documented Nighthawk case). Universal cutouts are
  therefore not enabled. The existing special glow path is separate.
- **Material assignments**: packed normal.w decoding is verified for the D2
  short4-normal strip format. Other formats retain their draw-call assignment;
  additional undocumented encodings have not been inferred from wear textures.
- **Lighting**: Three's sheen, SSS, BRDF, lighting rig and tone mapping differ
  from Tiger. ACES remains the explicit existing viewport default so lighting
  changes are not hidden inside a material rewrite.
- Family selection is tested for armor, weapons, ships, sparrows and Ghosts;
  browser rendering checks cover armor and weapons. The other families' full
  geometry and special-effect paths have not been visually compared in-game.

## Validation and repeatability

`lib/materials/fixtures/dye-corpus.json` contains the consumed raw armor dye fields
retrieved on the date above for Nighthawk, Relativism, Cover of the Exile,
Photo Finish, Superblack, Prismatic Expanse and Gambit Jadestone. The numerical
remap tests share the shader's arithmetic implementation, and corpus tests pass
all six tints through the server parser and client material builder.

The `/poc` renderer now accepts an optional shader hash, so texture resolution,
locked dye precedence and material comparisons can be repeated on a real mesh.
Blank uses the item's default appearance. Resource failures and unsupported effects appear in the warnings panel;
preview approximation details appear under Rendering notes. Browser checks cover real gear and shader swaps; they
are compilation/render smoke tests, not an in-game image-difference benchmark.

Validation on 2026-09-22: 109 tests passed, including the live Gjallarhorn asset
pipeline; TypeScript and changed-file lint passed; the production build passed.
The build reports existing lint warnings in `itemDefs.ts` and the integration
test. Browser smoke checks covered Nighthawk, Relativism, Cover of the Exile,
Photo Finish / Superblack swaps and Gjallarhorn, with no shader compile errors.

Material-separation validation on 2026-09-23: 128 tests passed, including the live
Gjallarhorn pipeline and the three requested armor examples' exported draw
records. TypeScript, changed-file lint and a clean production build passed
(the existing lint warnings listed above remain). An additional temporary
cross-check compared all decoded RGBA bytes of 19 real material PNGs with an
independent Pillow decode; every image matched. Browser smoke checks cover
Cover of the Exile, Relativism and Sixth Coyote; the resolved-metalness view was
also inspected on Cover and Relativism. These checks verify rendering and data
handling, not pixel parity with the game.

Alpha-reconstruction validation on 2026-09-24: 139 tests passed, including
rejection of color-only guesses, contradictory normal edges, invented metal
at dye boundaries, and opacity/emission mixing. TypeScript and changed-file
lint passed. The original textures retrieved on September 23 were also measured:
the final estimator changed 17 alpha-class texels across Sixth Coyote's 16
tiles, and zero on Cover of the Exile and Relativism. Continuous values are
still reconstructed within existing regions; these counts concern class changes
only, not every changed sample. The browser's Sixth Coyote metadata independently
reported the same 17 class changes and 16 reconstructed tiles.
Final browser smoke checks rendered all three armor examples without shader
errors; the decoded-alpha and estimated-boundary views were also exercised.
The production build passed with the existing lint warnings described above.

Vertex-material validation on 2026-09-25: all 147 tests passed, including raw
vertex/index regressions for both mask variants, Sixth Coyote and Relativism,
and the live Gjallarhorn pipeline. TypeScript, changed-file lint and production
build passed (the pre-existing lint warnings above remain). Browser checks
showed Cover's gold shell, white cloth and dark tube, plus three distinct regions
in the resolved-dye overlay. Sixth Coyote and Relativism rendered successfully;
the browser reported no rendering errors during these checks.

Texture-material validation on 2026-09-28: all 159 tests passed, including the
real Iron Companion Plate dye-map fixture and the live Gjallarhorn pipeline.
The final decoder/material checks passed all 68 targeted tests; changed-file
lint and the production build passed (the pre-existing lint warnings above
remain). Browser checks showed separate armor, fabric and collar materials on
Iron Companion Plate with its default appearance and Photo Finish, plus its
resolved-slot overlay. Cover of the Exile and Relativism still rendered
successfully, with no browser rendering errors during these checks.

Ray-glow validation on 2026-09-28: all 164 tests passed, including both real
vest variants (84 effect triangles each), texture-signature isolation, missing
input behavior and independent animation timing. TypeScript, changed-file
lint and the production build passed with the pre-existing warnings above.
The vest rendered soft transparent rays without the former solid cyan carriers
or browser rendering errors. This validates the preview, not game-pixel parity.

Shared-effect validation on 2026-09-28: all 169 tests passed, including both
Spacewalk body variants, both ray variants, independent card UVs, missing inputs,
opaque-pass isolation and unknown-program fallback. TypeScript, changed-file
lint and production build passed (existing warnings above remain). The browser
rendered Spacewalk without the black rectangular carrier, with no new rendering
errors after the completed update. This initial cloud preview was subsequently found to miss the authored symbol
masks; the September 29 correction above supersedes it. Unsupported effects
are still reported and hidden.

Symbol and palette validation on 2026-09-29: all 175 tests passed, including
original-UV sampling of both Spacewalk symbols, zero-emission and missing-motion
inputs, reference palette rows/alpha, and the live Gjallarhorn pipeline.
TypeScript, changed-file lint and production build passed (the existing lint
warnings above remain). The browser showed distinct luminous chest and hip
symbols on Spacewalk, no warnings for its successful resource loads, and no
rendering errors. Entheogenic Parasite Vest also loaded without rendering errors.
These are preview checks, not a comparison against current in-game screenshots.

Emission and surface-binding validation on 2026-09-30: all 189 tests passed,
including real effect-program records, Sage Protector's authored dyes, unbound
VFX texture isolation and the live Gjallarhorn pipeline. TypeScript, changed-file
lint and production build passed (the pre-existing warnings above remain).
Browser checks showed Sage Protector's tan/cream fabric and dark leather without
the false rainbow emission, preserved Spacewalk's chest/hip symbols and small
lights, and retained Entheogenic's cyan glow. Spacewalk Plate also exercised the
shared hologram fallback. Raw debug views and normal rendering were checked.
The reference-based hologram tint and bloom remain preview approximations;
these checks do not establish pixel-for-pixel parity with the game.
## Atlas-colored hologram variant - 2026-09-30

Legacy's Oath Vest (1657654553) exports a stage-7 shader-8 draw with precisely
`digital_cloud_plate` and `dust_snow_mask_med01` inputs, without Spacewalk's
`taken_stain_etch_palette`. Both body variants contain the emblem geometry.
This distinct signature now selects an atlas-colored hologram. Its blue/purple
color gradient comes from the diffuse atlas, and gearstack B supplies the
emissive silhouette, both sampled at the original armor-atlas coordinates.
Normalized per-island UVs are used only for cloud/dust modulation. Armor dye
emission must not replace the emblem's spatially varying authored colors.

The shader signature, not an item hash, selects this path. Unknown extra inputs,
partial signatures and opaque stages do not match it. Both atlas maps are
required; missing optional motion textures retain the static emblem. This path
does not enable Spacewalk's estimated tint on the armor. HDR brightness and
motion remain approximations because the export omits the full game program.
Regression fixtures preserve both original effect draws and their packed mask.