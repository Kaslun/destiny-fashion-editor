# Shader debug sweep — two randomized sets

> Historical investigation. The remap, material-ID and inferred dye-band
> conclusions below are superseded by [Destiny material implementation](DESTINY-MATERIALS.md).
> Keep these observations as regression examples, not as the current shader specification.

Date: 2026-07-27. Method: the new dev-drawer **Randomize set** button (random
armor piece + random shader per slot, hashes logged to the console), then every
gearstack debug channel 0–6, both remap-mode axes, and all three band modes.
Numbers below are **masked histograms of the real decoded textures** read out of
the live scene (UV padding excluded via the normal map's alpha), not readings
off the debug views — see "Finding 1" for why the debug views can't be read
numerically today.

## The two sets

**Set A** (Hunter)
```
helmet    131359121/1869315389   Iron Fellowship Casque · Cursed Azure
gauntlets 256904954/466236950    Shadow's Grips · Dawning Elegance
chest     1319537767/2877895744  Illuminus Vest (Majestic) · Envious Gaze
legs      3755454909/3204751449  Smoke Jumper Strides · Silkworm Weave
classItem 373079184/3923596505   Shroud of Flies · Rustworn
```

**Set B** (Hunter)
```
helmet    2174117797/2944573669  Woven Firesmith Mask · Ritualism
gauntlets 137386025/1489178157   Exodus Down Grips · Flowers of Io (Worn)
chest     654307116/2737886290   Skerren Corvus Vest · Häkke Camo
legs      2096778461/1364828723  Substitutional Alloy Strides · Mod Cerise
classItem 3352962401/2307426898  Skerren Corvus Cloak · SUROS Modular
```

---

## Finding 1 — debug channels were tone-mapped and sRGB-encoded — **FIXED**

> **Update after fixing.** The sweep found the sRGB half; fixing it surfaced a
> second, larger half. The renderer's output pass applies **both** tone mapping
> and the colour-space encode, and **R3F does not leave three's `NoToneMapping`
> default in place — it sets ACESFilmicToneMapping**, a strong artistic S-curve.
> So every debug reading was passing through an S-curve *and* an encode.
>
> Measured on the undyed-grey debug constant `vec3(0.15)`, which should reach
> the screen at 38/255: it measured **20/255** — under half its real value.
> After fixing both halves it measures **exactly 38/255**, and the channel-4
> greyscale now sits inside the raw texture's range (screen mean A 0.534
> against per-mesh raw means of 0.33–0.57, 0.1% of pixels above 224).
>
> Fix, in two parts because they cannot be done in the same place:
> - `sRGBTransferEOTF(dbg)` in `gearMaterial.ts` pre-inverts the encode so it
>   round-trips. Note: **not** `colorSpaceToWorking()`. That wraps
>   `ColorSpaceNode`, which indexes `.rgb`/`.a` off its input, and the node
>   builder flattens a `vec4(dbg, 1.0)` wrapper back to the underlying vec3
>   before it gets there — so `.a` compiles to a `.w` swizzle on a vec3 and the
>   whole pipeline fails to build. That failure is invisible to `tsc` and to
>   the test suite: it surfaces only as a WGSL error in the browser console,
>   with the model silently not rendering. `sRGBTransferEOTF` is vec3 -> vec3
>   and is exactly the inverse of the OETF the output pass applies.
> - `DebugToneMapping` in `ModelViewer.tsx` drops tone mapping to
>   `NoToneMapping` while a channel is active, restoring the renderer's original
>   value at channel 0. Tone mapping is a full-screen post pass in the WebGPU
>   path and `material.toneMapped` is honoured only by the legacy
>   `WebGLRenderer`, so a material cannot opt out of it.
>
> Verified by cycling every channel in a clean tab: no console errors, and the
> `vec3(0.15)` constant measures 38/255 on all 18,125 pixels that carry it.
>
> **The tone-mapping discovery matters well beyond the debug views**: the normal
> render has been going through ACES this whole time, which crushes blacks and
> compresses highlights. Every material default tuned by eye was tuned against
> that curve. Worth deciding deliberately whether a reference viewer aiming to
> match Bungie's look should use ACES, Neutral, or none — that choice is left
> alone here because it changes the main render, not just the tooling.

The original analysis follows.

### Original finding — debug channels 1–4 display sRGB-encoded values

`mat.outputNode = select(uDebugChannel.greaterThan(0.5), vec4(dbg, 1.0), output)`
writes the **raw** channel value as the fragment result, and the renderer then
applies its linear→sRGB output conversion (`WebGPURenderer` defaults to
`SRGBColorSpace`; nothing in `ModelViewer.tsx` overrides it). So a raw 0.5
displays as 0.74 and a raw 0.75 displays as 0.88 — everything reads roughly a
third brighter than it is, and mid-range data looks saturated.

Proof, independent of eyeballing: on set B the gearstack **A** channel over the
used UV area is concentrated in 128–191 (raw 0.50–0.75) on every mesh —

| mesh | A bins (0–31 … 224–255), % of used area |
|---|---|
| a0b44d79 | 1.2 · 0.2 · 0.2 · 2.2 · **31.0** · **53.5** · 10.0 · 1.7 |
| 03d397be | 5.7 · 0.4 · 0.5 · 2.9 · **14.0** · **54.6** · 19.8 · 2.1 |
| 691e8c52 | 7.3 · 0.8 · 6.1 · 22.3 · **30.0** · **20.9** · 9.9 · 2.6 |
| 1cb244c6 | 3.6 · 4.0 · 9.8 · 27.7 · **39.6** · 15.2 · 0.1 · 0 |

Channel 6, which computes `floor(gs.a * 8)` **before** the output encode, agrees
exactly — the body reads green/cyan (bands 4–5 = 0.5–0.75). Channel 4, which
passes the raw value through the encode, shows those same texels as near-white.
Two views of the same data disagree; the encoded one is the wrong one.

**Consequence:** any value read off channels 1–4 so far is inflated. Concretely,
"smoothness looks ~1.0 everywhere" is false — G is actually 0.375–0.62.

**Fix:** convert the debug colour sRGB→linear before assigning `outputNode`, so
the encode round-trips and the displayed grey equals the raw value.

## Finding 2 — dyeslot-plate argmax produces per-texel slot noise — **FIXED**

> **Update after fixing.** The original write-up got the mechanism half right
> and one sub-claim outright wrong.
>
> **Wrong:** "mip filtering before a hard threshold". The dyeslot plate is
> already `NearestFilter` with `generateMipmaps = false`, and already gets a 3x3
> median despeckle at assembly (`loadGearModel.ts` / `despeckle.ts`). Filtering
> was never involved.
>
> **The actual mechanism**, measured by reading the assembled plates directly:
> of the texels a plate positively assigns, only **12–39% have a clear winner**,
> while **34–79% are two-way ties** whose average sorted channels are
> ~`[209, 208, 12]` — two slots essentially equal, the third at zero. argmax on
> a tie is a coin flip, so wherever two weight fields cross, the slot flips per
> texel.
>
> Those ties are **authored regions, not compression noise**: only 4.8–17.7% of
> tie texels touch a clear-winner texel, ~3.8 of their 4 neighbours are also
> ties, and their horizontal runs average 13–42px on a 512px plate. Block
> artifacts at a boundary would be 1–2px runs almost all touching a clear
> region. The existing per-channel median despeckle cannot help either: each
> channel is individually smooth: it is the *sign of their difference* that
> flips.
>
> **Fix:** use the weights as weights. `slotWeights` is a normalised vec3, and
> the material-table lookup became a weighted sum across all three slots. It is
> continuous, so speckle cannot occur by construction, and a one-hot vector
> reproduces the old single-row read exactly — so every mesh without a plate is
> bit-identical, and within a plate only genuinely-shared texels change.
> `materialTypeId` is deliberately still read from the dominant slot (an
> interpolated enum would match no known id and silently kill the emissive
> gate), and `oneHotSlot` clamps negative slots to 0 to preserve the old
> `slotRounded` behaviour for the several `matRow` reads that are not behind the
> `isDyed` gate.
>
> Measured on four real plates, adjacent assigned texel pairs:
>
> | plate | old argmax slot-flip rate | old adjacent jump | new adjacent jump |
> |---|---|---|---|
> | 5c265eb1 | 8.34% | 21.3 | 11.3 |
> | 428fe60e | 5.06% | 12.9 | 6.2 |
> | cf2a3387 | 1.24% | 3.2 | 4.5 |
> | 4e0dd808 | 0% | 0 | 0 |
>
> The last row is the useful control: a plate with no ties is untouched (0 → 0),
> confirming the degenerate case empirically rather than only by argument. The
> third shows the new decode is not merely "smoother" — on a clean plate it
> tracks real weight gradients instead of quantising them, so its jump can be
> slightly higher. The number that matters is the flip rate, which is now zero
> everywhere because the decode is continuous.
>
> The resolved-slot debug view now draws from `slotWeights` too, so it shows
> what is actually rendered (shared regions read as a blend, e.g. cyan, rather
> than salt-and-pepper). If speckle ever reappears there, the decode really has
> regressed rather than the view disagreeing with the render.

The original analysis follows.

### Original finding — dyeslot-plate argmax produces per-texel slot noise

Channel 5 on **set A** is salt-and-pepper: red and blue interleaved at texel
scale across the chest and arms. On **set B** the same view is clean, contiguous
regions. The difference is the dyeslot plate: set B's six meshes ship **no
plate at all**; set A's ship plates that are almost entirely zero with a
scattering of low values.

| set A mesh | plate R/G/B means | % texels at 0–31 |
|---|---|---|
| f54d1f1c | 3.1 / 4.6 / 4.2 | 97.4 / 97.3 / 97.5 |
| f956df5c | 1.3 / 6.8 / 3.7 | 98.9 / 97.1 / 97.7 |
| 5ccfd4d5 | 0.0 / 6.4 / 0.7 | 100 / 97.1 / 99.3 (R max is literally 0) |

The decode is:

```ts
const dyeslotSlot = select(sum.lessThan(0.03), float(-1), argmax);
```

`sum < 0.03` rejects only texels whose three channels total under ~7.6/255.
With a plate whose signal floor sits right at that level, texels flip between
"baked → fallback" and "argmax says slot 1" on single-LSB differences. On
5ccfd4d5 specifically, R is identically 0 and G averages 6.4/255, so the
comparison `qr >= qg` fails on essentially any non-zero G and the argmax lands
on slot 1 — but only for the texels that clear 0.03. That is exactly the
observed speckle.

The fallback is not the culprit here: set A's pieces have per-part slot
variation (channel 5 shows several slots per piece), so `needsBandSplit` is
false, `bandSlotF` is null, and `fallbackSlotF` is a **flat** per-part constant
that cannot produce noise.

Two compounding issues:
1. **Noise floor.** `sum < 0.03` is far below the real signal (which reaches
   255). A max-based test with a runner-up margin — e.g. require
   `max(r,g,b) > ~0.25` *and* a margin over the second-highest — matches how the
   data is actually authored.
2. **Mip filtering before a hard threshold.** `texture(maps.dyeslot, uvN)` is
   sampled with default filtering, then argmax'd. This is the same bug already
   fixed for the A channel (`gsSharpA` samples `.level(int(0))` precisely
   because "mip minification blurs A across hard thresholds"); the dyeslot plate
   is thresholded *harder* and never got the same treatment.

## Finding 3 — the mode-0 band thresholds sit on the peak of the A distribution

`BAND_DEFAULTS = { t1: 0.5, t2: 0.625 }`, and A is concentrated in 0.50–0.75 on
every mesh measured (table in Finding 1). t2 = 0.625 lands precisely on the
boundary between the two most populated bins, and t1 = 0.5 cuts through the
third. Placing a hard cut at the *mode* of the distribution makes slot
assignment maximally sensitive to texture noise; a threshold wants to sit in a
valley.

These defaults were tuned off Cover of the Exile's channel-6 view. That reading
is still valid (channel 6 computes its bands before the output encode), but the
distribution it was tuned against does not look like the distribution on
ordinary armor.

## Finding 4 — the band-decode controls are inert on most armor, with no UI signal

Switching between all three band modes on set B produced a **pixel-identical**
render, as do the t1/t2 sliders. Reason: `bandSplit` requires `needsBandSplit`
(every non-glow stage part decoding to the same slot) plus `singlePart`, so on
multi-part armor `bandSlotF` is null and `uBandMode` / `uBandT1` / `uBandT2` are
never wired into the graph — but they *are* always created and always exposed on
`userData.uniforms`, so the panel looks live.

This is a trap for tuning: a session on a set like B would conclude "band mode
doesn't matter" from a set where it structurally cannot. The panel should grey
these out (or badge them) when no equipped piece qualifies.

## Finding 5 — AO contributes essentially nothing, and what it does contribute is hard-edged art

Gearstack R over the used UV area, set B, % of texels at 224–255:
97.5, 82.3, 74.9, 66.2, 66.2 — and 37.9 on the one outlier (a79099bf, which also
has 28.6% at 0–31). Set A's helmet is 98% saturated over its used area.

With `ao = mix(0.5, 1.0, gs.r)` that means AO ≈ 1.0 across the great majority of
every surface: no contact shading, no crevice darkening, which is a large part
of why the assembled character reads flat. Meanwhile the darkening that *does*
happen is concentrated in hard-edged blobs (helmet spikes, gauntlet panels, hip
pouches — visible in the channel-1 view on both sets) and dithered speckle on
set B's legs/boots. That is the "Memory of Cayde's cape" pattern the existing
comment describes, generalized: R is not organic occlusion on this data, so
using it as AO darkens exactly the places that shouldn't be darkened while doing
nothing everywhere else.

## Finding 6 — the default roughness remap mode over-glosses ordinary armor

Flipping roughness remap between mode 2 (`scale/bias → band clamp`, the default)
and mode 0 (`range`) on set B is a large, obvious difference: the default gives
the helmet a chrome/wet blowout and puts a hard specular sheen on the chest;
`range` reads as dry cloth and leather.

The measured G (smoothness) is 0.375–0.62 across the set, i.e. roughness
0.4–0.6 — matte-ish. The default is pushing well past that. The existing
`DEFAULT_ROUGHNESS_REMAP_MODE = 2` was chosen on Celestial Nighthawk's gold,
where sharp reflections are the point; it appears to be a bad default for the
non-metal majority. Worth re-deciding against a wider corpus, possibly per
material type rather than one global mode.

## Finding 7 — corroborated: wear band-clamp degenerates set-wide, not just on Nighthawk

Switching wear remap to either scale/bias mode washes set B pale grey-cream —
the documented "saturates to fully-worn, replaces the tint with wornAlbedo"
failure, now confirmed on an unrelated set. `DEFAULT_WEAR_REMAP_MODE = 0` is
correct and the note in `gearMaterial.ts` should be widened from "at least one
item" to "systemic".

## Finding 8 — the secondary tint is never selected

Across all 10 pieces, channel 5 showed **zero** dim (secondary-parity) texels —
every dyed texel resolved to a primary tint. With band decode inert on
multi-part armor (Finding 4), `parityF` reduces to the stage part's own
`useSecondary` flag, so half the authored material table (3 of the 6
slot×parity materials) goes unused on every piece sampled. Either these items
genuinely never flag secondary parts — worth checking against the raw
`gear_dye_change_color_index` values — or the parity decode isn't reaching the
render.

## Also observed, lower confidence

- **Dye strength is wildly inconsistent between items.** Set A's legs (Smoke
  Jumper Strides · Silkworm Weave) render neon lime; set B is near-monochrome
  grey despite carrying Mod Cerise and Häkke Camo. Both extremes look wrong.
  Not yet traced — likely interacts with the saturation gate in the plated dye
  path, which would explain "either the tint takes fully or it barely takes".
- **Zero-gearstack regions render undyed and dark.** Where all four channels are
  ~0 (set B's boots, set A's helmet spikes) the pixel gets `dyeMask = 0`,
  smoothness 0 and `ao = 0.5`. Those are the regions the B channel puts in the
  0–32 alpha-test band, which the shader deliberately does not apply. Set B puts
  **12–48% of used area** in that band (47.8% on the legs) — much more prevalent
  than the 27% Nighthawk figure that drove the "don't discard" decision, so the
  missing per-part alpha-test flag is a bigger gap than that note implies.

## Suggested order of attack

1. ~~Finding 1~~ — **done**; the debug views are now numerically readable.
2. **Decide on tone mapping** (raised by the Finding 1 fix). The main render is
   on ACES by R3F default, not by choice, and every by-eye material default was
   tuned against it. This should be settled before re-tuning anything below,
   or the retune inherits the same unexamined curve.
3. ~~Finding 2~~ — **done**; the plate's weights are now used as weights.
4. Finding 5 / Finding 6 — the two things making everything read flat-but-shiny.
   Both readings should be re-checked once step 2 is settled.
5. Finding 4 — cheap UI guard that prevents future mis-tuning.
6. Finding 3 / Finding 8 — now unblocked by the corrected debug views.

## Tone-mapping comparison (data for step 2)

Same set, same camera, same lights; only `renderer.toneMapping` differs. Stats
masked to the Guardian silhouette, 0–255 luminance. Set A = default unshaded
set; set B = randomized + shaded (saturated orange arms, emissive cyan visor).

| set | mode | mean | p01 | p50 | p99 | clipped ≥250 | mean sat |
|---|---|---|---|---|---|---|---|
| A | ACES | 105.1 | 15.2 | 100.8 | 211.0 | 0% | 16.1% |
| A | Neutral | 86.9 | 10.6 | 82.2 | 207.0 | 0% | **21.2%** |
| A | None | 103.1 | 17.1 | 98.6 | 214.8 | 0.11% | 13.9% |
| B | ACES | 95.4 | 6.2 | 87.3 | 207.1 | 0% | 24.0% |
| B | Neutral | 79.0 | 4.4 | 72.0 | 199.0 | 0.09% | **30.8%** |
| B | None | 96.0 | 7.1 | 89.3 | 207.0 | 0.26% | 20.7% |

- Neutral is consistently **darker** (mean −17% vs ACES) and **more saturated**
  (+28–31% relative). Caveat: the saturation metric is `(max−min)/max`, which
  rises as an image darkens, so part of that gap is the brightness difference
  rather than pure chroma preservation. The direction is corroborated by intent
  though — Khronos PBR Neutral exists specifically to keep authored albedo.
- None is the only mode that **clips** (0.26% of the saturated set already
  blown), because nothing tames values above 1.0.
- Differences are **localized**: peak |ACES − Neutral| is 54/255 on set A and
  131/255 on set B, but the mean is only ~6 levels. The curves agree across the
  muted bulk of the armor and diverge on bright/saturated/emissive regions —
  judge on those, not on overall impression.

Recommendation: **Neutral**, because a transmog previewer's job is to show what
a shader will actually look like, and Neutral is the curve built to preserve
material colour; ACES is a film look that arrived by R3F default rather than by
choice. Expect to need a compensating exposure/lighting bump, since Neutral runs
notably darker.

**The default is still ACES** — unchanged, so nothing about the render moved.
The three curves are now a live A/B control at the top of the dev drawer
(`components/viewer/toneMapping.ts` defines the options as semantic keys;
`ModelViewer` maps them onto the THREE constants). Switching the default is a
one-line change to `DEFAULT_TONE_MAPPING` once the lighting rig has been
re-checked against it.

The debug channels still force `NoToneMapping` regardless of what is selected,
so channel readings stay raw whichever curve is active — verified with Neutral
selected: the `vec3(0.15)` constant still measures exactly 38/255, and
returning to channel 0 restores Neutral rather than snapping back to ACES.

## Unrelated, pre-existing

`lib/materials/gearDye.test.ts:124` (`rankSlotsSoftToHard` on Nighthawk) fails
on `main` — confirmed by stashing all of the above and re-running. 89 of 90
tests pass. Not touched here.
