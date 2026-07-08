/**
 * Builds Three.js materials for a gear mesh, one per geometry group.
 *
 * Opaque groups extend MeshStandardMaterial with Destiny's gearstack logic
 * (injected via onBeforeCompile):
 *
 *   gearstack channels (D2):  R = ambient occlusion
 *                             G = smoothness (inverted -> roughness)
 *                             B = emissive mask (small bright emblem regions)
 *                             A = primary/secondary dye split
 *
 *   dyeslot plate (when present): per-pixel dye-zone mask — R/G/B = dye slot
 *   0/1/2 (confirmed empirically; more precise than thresholding gearstack.A).
 *
 * DYE only recolours the greyscale "change-colour" shell. The diffuse plate
 * also carries BAKED-COLOUR cells (e.g. Nighthawk's gold eye, its red/white
 * emblem) that must survive untouched — so the plated dye is gated by pixel
 * saturation: near-grey texels take the tint, saturated texels pass through.
 *
 * Decal groups (stage-part flag 0x8 — e.g. Nighthawk's emblem panel) are
 * OPAQUE overlay geometry with their own baked texture, not additive glows.
 * They render opaque with a polygon offset so they sit on the shell without
 * z-fighting, and are NOT dyed (the emblem art is fixed).
 */
import * as THREE from "three";
import { dyeForSlot, type DyeSet } from "./gearDye";
import type { GroupInfo } from "@/lib/geometry/buildGeometry";

/**
 * Live gearstack-channel viewer. 0 = normal rendering; 1-4 override every pixel
 * with a greyscale view of the gearstack R/G/B/A channel (bright = high value),
 * so material boundaries baked into the texture (dye mask, metalness, wear
 * bands) can be inspected directly instead of guessed at from the lit render.
 * Wired to a uniform (not compiled in/out) so `setGearstackDebugChannel` can
 * flip it on an already-loaded model without rebuilding materials.
 */
export const GEARSTACK_CHANNELS = ["off", "r (ao)", "g (smoothness)", "b (emissive/alpha-test)", "a (dye mask / metalness / wear)"] as const;
export type GearstackDebugChannel = 0 | 1 | 2 | 3 | 4;

/** Push a debug-channel selection to every gearstack-enabled material under `root`. */
export function setGearstackDebugChannel(root: THREE.Object3D, channel: GearstackDebugChannel): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const shader = (m.userData as { shader?: { uniforms: Record<string, { value: unknown }> } }).shader;
      if (shader?.uniforms.uDebugChannel) shader.uniforms.uDebugChannel.value = channel;
    }
  });
}


export interface GearTextureMaps {
  diffuse?: THREE.Texture;
  normal?: THREE.Texture;
  gearstack?: THREE.Texture;
  /** per-pixel dye-slot mask plate (R/G/B = slot 0/1/2) */
  dyeslot?: THREE.Texture;
  /** dedicated glow/illum mask (only some items have one) */
  emissive?: THREE.Texture;
}

export interface GearMaterialOptions {
  /** Apply gearstack AO + smoothness to the PBR response. */
  useGearstack?: boolean;
  /** Tint the albedo with the resolved dye colours. */
  applyDye?: boolean;
  /**
   * True for plate-based armor: its diffuse is greyscale detail, so the dye
   * fully colours it (brighten + tint). False for weapons/items with a baked
   * colour diffuse, where the dye only tints the masked trim and the painted
   * body is preserved.
   */
  plated?: boolean;
}

/**
 * Nighthawk's eye/faceplate: the diffuse is a gold emblem on black (~half/half).
 * Render it as REFLECTIVE gold metal, with the black surround cut out by alpha
 * so it's transparent (not an opaque black socket), plus a subtle self-glow.
 * The diffuse doubles as the alpha map — its green channel is high on the gold,
 * ~0 on the black, so `alphaTest` discards the black and keeps the gold.
 */
function makeGlow(maps: GearTextureMaps): THREE.Material {
  if (maps.diffuse) maps.diffuse.colorSpace = THREE.LinearSRGBColorSpace;
  return new THREE.MeshStandardMaterial({
    map: maps.diffuse ?? null,
    alphaMap: maps.diffuse ?? null,
    transparent: true,
    alphaTest: 0.01,
    metalness: 0,
    roughness: 0,
    emissiveMap: maps.diffuse ?? null,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 1,
    side: THREE.FrontSide,
  });
}

function makeOpaque(
  dyeIndex: number,
  dyes: DyeSet,
  maps: GearTextureMaps,
  opts: GearMaterialOptions,
  overlay = false,
): THREE.Material {
  // gear_dye_change_color_index -> dye slot, when no per-pixel dyeslot plate
  // exists (the common case: many items ship a `dyeslot` plate entry with zero
  // placements, so it never assembles into a real mask). We used to force this
  // through `(cc * 2) % 3`, a formula reverse-engineered to fit exactly one
  // item (Nighthawk: cc {0,5,1} on the face/crown/visor -> slots {0,1,2}) — it
  // silently wraps any out-of-range index into an unrelated slot, which on
  // Cover of the Exile (a single group, cc=3, only 3 known slots) tinted the
  // entire cloth/leather shell with slot 0's gold-metal primary. Index the dye
  // set directly instead: a cc with no matching resolved slot skips dyeing
  // (dyeForSlot's NEUTRAL fallback is white/no-op), letting the baked diffuse
  // show through untouched, rather than borrowing an unrelated slot's colour.
  // Known trade-off: this changes Nighthawk's group->slot assignment too (cc=5
  // no longer wraps to slot 1, cc=1 no longer wraps to slot 2) since it relied
  // on the same wraparound.
  const slot = dyeIndex;
  const dye = dyeForSlot(dyes, slot);

  // Emissive tint: dyes carry the glow colour (e.g. Nighthawk's red eye,
  // Bushido's blue emblem); glowing regions self-illuminate in their albedo
  // colour when the dye specifies none.
  const emissiveOn = dye.emissive.r + dye.emissive.g + dye.emissive.b > 0.02;
  const emissiveTint = emissiveOn ? dye.emissive.clone() : new THREE.Color(0xffffff);

  const mat = new THREE.MeshStandardMaterial({
    map: maps.diffuse ?? null,
    normalMap: maps.normal ?? null,
    color: maps.diffuse ? new THREE.Color(0xffffff) : dye.primary.clone(),
    metalness: dye.metalness,
    roughness: dye.roughness,
    emissiveMap: maps.emissive ?? null,
    emissive: maps.emissive ? emissiveTint : new THREE.Color(0, 0, 0),
    emissiveIntensity: maps.emissive ? 1.5 : 1,
    side: THREE.DoubleSide, // Destiny meshes aren't always consistently wound
  });

  // Overlay (decal) geometry sits on top of the shell — nudge it toward the
  // camera so its own polygons win the depth test instead of z-fighting.
  if (overlay) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
  }

  // Dye every group (incl. overlay parts like Nighthawk's crown). Baked art is
  // preserved per-pixel by the region mask (slot 0 = "don't dye") and by the
  // saturation gate, so enabling dye here no longer recolours emblems.
  const dyeOn = !!opts.applyDye;

  if (maps.diffuse) maps.diffuse.colorSpace = THREE.SRGBColorSpace;
  if (maps.emissive) maps.emissive.colorSpace = THREE.SRGBColorSpace;

  // Per-slot tiled detail maps (resolved from names by the loader). The detail
  // DIFFUSE is a linear micro-surface albedo (cloth weave, metal grain) that
  // MULTIPLIES the base albedo; the detail NORMAL adds micro-relief. These are
  // what make cloth read as cloth rather than smooth plastic. Tiling comes from
  // detailTransform = [scaleX, scaleY, offsetX, offsetY].
  // NOTE: this applies the CURRENT GROUP's slot detail map uniformly. With a
  // per-pixel dyeslot plate, different pixels are different slots (each with its
  // own detail map); blending all three per-pixel is possible but heavy, and the
  // per-group slot matches how dyeing already resolves. Good enough for the
  // common case; revisit if a single group visibly mixes cloth + metal regions.
  const detailDiffuse = dye.detailDiffuse ?? null;
  const detailNormal = dye.detailNormal ?? null;
  if (detailDiffuse) detailDiffuse.colorSpace = THREE.LinearSRGBColorSpace;
  if (detailDiffuse) {
    detailDiffuse.wrapS = detailDiffuse.wrapT = THREE.RepeatWrapping;
  }
  if (detailNormal) {
    detailNormal.wrapS = detailNormal.wrapT = THREE.RepeatWrapping;
  }

  // The detail DIFFUSE is a change-colour micro-surface (cloth weave, worn
  // grain). It belongs ONLY on dyeable greyscale-shell surfaces. On baked-art
  // plate items (Celestial Nighthawk: gold faceplate, white/red emblem, brown
  // crown) the base diffuse is the FINISHED art — multiplying a tiled weave
  // over it stamps fabric across the gold and emblem (visibly wrong). Bungie's
  // shader gates the detail contribution to the change-colour region; we don't
  // have that per-pixel gate available before the dye block runs, so use the
  // coarse but correct rule: skip detail diffuse on plated (baked-art) items.
  // Cloth/greyscale-shell items (plated=false) are fully dyeable shell, so the
  // detail diffuse applies across them — which is what makes the vest read as
  // woven. Detail NORMAL is micro-relief only (no albedo stamping) and is
  // comparatively safe, but on baked-art plate it also adds a woven bump to the
  // gold reflections, so gate it the same way.
  // Detail maps are weighted per-slot by detailStrength (material_params[0]) in
  // the shader below: strength 0 (e.g. Nighthawk's gold plate) contributes
  // nothing, so no coarse plated gate is needed — the weight handles baked-art
  // and cloth correctly from the same data.
  const hasDetailDiffuse = !!detailDiffuse;
  const hasDetailNormal = !!detailNormal;
  const dt = dye.detailTransform;

  // Gearstack/detail injection needs the diffuse map's UV varying (vMapUv).
  const wantGearstack = opts.useGearstack && !!maps.gearstack && !!maps.diffuse;
  // Detail maps also need vMapUv (they tile over the base UVs). Run the custom
  // compile if EITHER gearstack or detail maps are in play.
  const wantDetail = (hasDetailDiffuse || hasDetailNormal) && !!maps.diffuse;
  if (!wantGearstack && !wantDetail) return mat;

  const hasDyeslot = !!maps.dyeslot;
  // All three slots' tints (albedo AND glow, per the shader anatomy: each slot
  // = metal/cloth/accent with primary+secondary colour and primary+secondary
  // glow) — the dyeslot plate selects the slot per pixel.
  const primaries = [0, 1, 2].map((s) => dyeForSlot(dyes, s).primary);
  const secondaries = [0, 1, 2].map((s) => dyeForSlot(dyes, s).secondary);
  const worns = [0, 1, 2].map((s) => dyeForSlot(dyes, s).worn);
  const primEmissives = [0, 1, 2].map((s) => dyeForSlot(dyes, s).emissive);
  const secEmissives = [0, 1, 2].map((s) => dyeForSlot(dyes, s).secondaryEmissive);
  // Per-slot metalness/cloth (e.g. slot 0 = metal buckle, slot 1 = cloth shell,
  // slot 2 = leather trim). The group-level `slot`/`uSlotCloth` below is a
  // single-value fallback derived from an empirical dyeIndex heuristic that
  // doesn't hold across items; when a real per-pixel dyeslot plate exists, the
  // metalness/roughness blocks index these arrays per-pixel instead so a group
  // whose UVs span multiple material slots doesn't get painted with one slot's
  // metalness across its whole surface.
  const metalnesses = [0, 1, 2].map((s) => dyeForSlot(dyes, s).metalness);
  const cloths = [0, 1, 2].map((s) => (dyeForSlot(dyes, s).cloth ? 1 : 0));

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGearstack = { value: maps.gearstack ?? null };
    shader.uniforms.uDebugChannel = { value: 0 };
    shader.uniforms.uPrimaryTint = { value: dye.primary };
    shader.uniforms.uSecondaryTint = { value: dye.secondary };
    shader.uniforms.uApplyDye = { value: dyeOn ? 1 : 0 };
    shader.uniforms.uPlated = { value: opts.plated ? 1 : 0 };
    shader.uniforms.uEmissiveTint = { value: dye.emissive };
    shader.uniforms.uEmissiveOn = { value: emissiveOn ? 1 : 0 };
    shader.uniforms.uDyeslot = { value: maps.dyeslot ?? null };
    shader.uniforms.uHasDyeslot = { value: hasDyeslot ? 1 : 0 };
    shader.uniforms.uPrimaries = { value: primaries };
    shader.uniforms.uSecondaries = { value: secondaries };
    shader.uniforms.uWorns = { value: worns };
    shader.uniforms.uWornTint = { value: dye.worn };
    shader.uniforms.uPrimEmissives = { value: primEmissives };
    shader.uniforms.uSecEmissives = { value: secEmissives };
    shader.uniforms.uSlotIndex = { value: slot };
    shader.uniforms.uMetalnesses = { value: metalnesses };
    shader.uniforms.uCloths = { value: cloths };
    // Detail-map uniforms.
    shader.uniforms.uDetailDiffuse = { value: detailDiffuse };
    shader.uniforms.uDetailNormal = { value: detailNormal };
    shader.uniforms.uHasDetailDiffuse = { value: hasDetailDiffuse ? 1 : 0 };
    shader.uniforms.uDetailStrength = { value: dye.detailStrength ?? 0 };
    shader.uniforms.uSlotCloth = { value: dye.cloth ? 1 : 0 };
    shader.uniforms.uHasDetailNormal = { value: hasDetailNormal ? 1 : 0 };
    shader.uniforms.uDetailNormalScale = { value: 0.4 };
    // xy = tiling scale, zw = offset.
    shader.uniforms.uDetailTransform = {
      value: new THREE.Vector4(dt[0], dt[1], dt[2], dt[3]),
    };

    shader.fragmentShader =
      `uniform float uSlotIndex;
uniform float uDebugChannel;
uniform sampler2D uGearstack;
uniform vec3 uPrimaryTint;
uniform vec3 uSecondaryTint;
uniform float uApplyDye;
uniform float uPlated;
uniform vec3 uEmissiveTint;
uniform float uEmissiveOn;
uniform sampler2D uDyeslot;
uniform float uHasDyeslot;
uniform vec3 uPrimaries[3];
uniform vec3 uSecondaries[3];
uniform vec3 uWorns[3];
uniform vec3 uWornTint;
uniform vec3 uPrimEmissives[3];
uniform vec3 uSecEmissives[3];
uniform float uMetalnesses[3];
uniform float uCloths[3];
uniform sampler2D uDetailDiffuse;
uniform sampler2D uDetailNormal;
uniform float uHasDetailDiffuse;
uniform float uDetailStrength;
uniform float uSlotCloth;
uniform float uHasDetailNormal;
uniform float uDetailNormalScale;
uniform vec4 uDetailTransform;

// --- Destiny 2 gearstack decode --------------------------------------------
// Channel meanings confirmed by Bungie's Graphics Tech Art Lead (via lowlines'
// Spasm port):
//   R = ambient occlusion
//   G = smoothness            (roughness = 1 - G, remapped)
//   B = encoded alpha-test + emissive
//   A = encoded dye mask + non-dyed metalness + wear mask
// The alpha channel packs three signals into value bands (the /32, 40/255,
// 48/255 constants are Bungie's, ported verbatim). Decoding it gives us the
// per-pixel metalness and wear the name classifier could only guess at.
struct Gearstack {
  float ao;
  float smoothness;
  float metalness;   // non-dyed metalness, 0..1
  float dyeMask;     // 1 where the surface is dyeable, 0 on baked art
  float wear;        // 0..1 worn amount
  float emissive;    // 0..1 emissive strength
  float alphaTest;   // 0..1 (for cut-out geometry)
};
Gearstack decodeGearstack( vec4 gs ) {
  Gearstack g;
  float a255 = gs.a * 255.0;
  float b255 = gs.b * 255.0;
  g.ao         = gs.r;
  g.smoothness = gs.g;
  g.metalness  = clamp( a255 / 32.0, 0.0, 1.0 );
  g.dyeMask    = step( 40.0 / 255.0, gs.a );
  g.wear       = clamp( ( gs.a - 48.0 / 255.0 ) * ( 255.0 / ( 255.0 - 48.0 ) ), 0.0, 1.0 );
  // Emissive lives in the HIGH blue band. The low band (b < 32/255) is
  // alpha-test data and the 32..~64 range carries structural/edge values that
  // are NOT glow — decoding the whole >40 range as emissive lights up beak
  // vents and panel seams as white bars. Start the emissive ramp well above the
  // alpha-test band and require a real signal (>~0.5 blue) before it counts, so
  // only genuinely emissive cells (glowing eyes, tech lines) contribute.
  g.emissive   = clamp( ( gs.b - 128.0 / 255.0 ) * ( 255.0 / ( 255.0 - 128.0 ) ), 0.0, 1.0 );
  g.alphaTest  = clamp( b255 / 32.0, 0.0, 1.0 );
  return g;
}
` +
      shader.fragmentShader;

    // Detail DIFFUSE blend: runs first, modulating the base albedo before dye
    // tinting. Tiled by uDetailTransform. Centered around 1.0 (a detail map is a
    // multiplier: ~0.5 grey = neutral) via 2x so it darkens AND brightens the
    // weave/grain rather than only darkening. Skipped if unresolved.
    // Detail DIFFUSE: a tiled micro-surface luminance overlay (kevlar weave,
    // fabric grain), NOT a replacement albedo. Bungie weights its contribution
    // per slot via material_params[0] (uDetailStrength): 0 = none (Nighthawk's
    // gold faceplate), 1 = full (cloth). Blend as a soft multiply around 1.0 so
    // it modulates rather than stamps, then lerp by strength so zero-strength
    // slots keep their base albedo untouched. This replaces the earlier flat
    // 2x multiply, which crushed baked art (gold/emblem) under the weave.
    if (hasDetailDiffuse) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        if ( uHasDetailDiffuse > 0.5 && uDetailStrength > 0.001 ) {
          vec2 dUv = vMapUv * uDetailTransform.xy + uDetailTransform.zw;
          float dl = dot( texture2D( uDetailDiffuse, dUv ).rgb, vec3(0.299,0.587,0.114) );
          // Modulate around neutral (0.5 detail luminance = no change), scaled
          // by strength. Range reduced from 0.8 -> 0.5 so the tiled grain reads
          // as a subtle surface texture, not a hard printed pattern.
          float mod = 1.0 + ( dl - 0.5 ) * 0.5 * uDetailStrength;
          diffuseColor.rgb *= mod;
        }`,
      );
    }

    // Detail NORMAL: micro-relief, weighted by detail strength AND a global
    // scale (uDetailNormalScale). The raw detail normal on leather/fabric slots
    // is authored strong; at full contribution the crown's grain reads as an
    // over-obvious stamped pattern. Scale it down to a subtle micro-relief.
    // Exposed as a uniform so it can be dialled live via userData.shader.
    if (hasDetailNormal) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        if ( uHasDetailNormal > 0.5 && uDetailStrength > 0.001 ) {
          vec2 dnUv = vMapUv * uDetailTransform.xy + uDetailTransform.zw;
          vec3 dn = texture2D( uDetailNormal, dnUv ).xyz * 2.0 - 1.0;
          normal = normalize( vec3( normal.xy + dn.xy * uDetailStrength * uDetailNormalScale, normal.z ) );
        }`,
      );
    }

    // Gearstack dye + AO block. Only when the item actually has a gearstack
    // texture — detail-only items (e.g. many cloth pieces) skip all of this.
    if (wantGearstack) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          vec4 gsRaw = texture2D( uGearstack, vMapUv );
          Gearstack gs = decodeGearstack( gsRaw );
          // Brightness/saturation for the baked-art gate, measured on the RAW
          // albedo BEFORE AO darkening — otherwise AO pushes shaded parts of a
          // white panel below the threshold and dye bleeds over them.
          float albLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
          float albSat = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) )
            - min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) );

          if ( uApplyDye > 0.5 ) {
            // Slot colours for this pixel. A per-pixel dyeslot plate (R = 1-based
            // slot index) when present; else this part's single slot.
            vec3 pri = uPrimaryTint;
            vec3 sec = uSecondaryTint;
            vec3 wrn = uWornTint;
            int si = -1;
            bool doDye = true;
            if ( uHasDyeslot > 0.5 ) {
              float q = floor( texture2D( uDyeslot, vMapUv ).r * 3.0 + 0.5 );
              if ( q < 0.5 ) {
                doDye = false;
              } else {
                si = int( q ) - 1;
                pri = uPrimaries[si];
                sec = uSecondaries[si];
                wrn = uWorns[si];
              }
            }

            // Decoded dye mask is the authoritative "is this pixel dyeable"
            // signal (0 on baked emblems/glows, 1 on the change-colour shell).
            // For plated baked-art items we AND it with the saturation gate as a
            // belt-and-braces guard, since some mobile plates carry imperfect
            // masks; for everything else the decoded mask stands on its own.
            float dyeMask = gs.dyeMask;

            if ( doDye ) {
              if ( uPlated > 0.5 ) {
                // Baked-art plate: keep saturated/bright/very-dark cells (emblem,
                // trim, hawk) intact; dye only the near-grey shell. Combine the
                // decoded mask with the saturation gate.
                float greyMask = ( 1.0 - smoothstep( 0.06, 0.16, albSat ) )
                  * ( 1.0 - smoothstep( 0.30, 0.48, albLum ) )
                  * smoothstep( 0.04, 0.11, albLum );
                float m = dyeMask * greyMask;
                vec3 tint = ( uSlotIndex < 0.5 ) ? pri : mix( pri, sec, 0.0 );
                vec3 dyed = clamp( diffuseColor.rgb * 1.7, 0.0, 1.1 ) * tint;
                diffuseColor.rgb = mix( diffuseColor.rgb, dyed, m );
                // Wear: blend the dyed shell toward the worn tint where the wear
                // mask is high (scratched/edge-worn metal reads darker/duller).
                diffuseColor.rgb = mix( diffuseColor.rgb,
                  diffuseColor.rgb * wrn, gs.wear * m );
              } else {
                // Change-colour shell (weapons, cloth): dye the masked region,
                // preserving painted body. Tint multiplies the shell albedo.
                vec3 tint = pri;
                diffuseColor.rgb = mix( diffuseColor.rgb,
                  diffuseColor.rgb * tint, dyeMask );
                diffuseColor.rgb = mix( diffuseColor.rgb,
                  diffuseColor.rgb * wrn, gs.wear * dyeMask );
              }
            }
          }
        }`,
      );

      // G = smoothness -> roughness (inverted). This is Bungie's per-pixel gloss
      // source; the dye's roughness_remap endpoints refine the range but the
      // gearstack green channel carries the spatial detail (polished vs brushed).
      // The cloth floor is PER-PIXEL when a dyeslot plate exists — a group's UVs
      // can span multiple material slots (metal buckle + cloth shell + leather
      // trim in one mesh group), so a single group-wide uSlotCloth would clamp
      // the whole group to one slot's floor. Fall back to uSlotCloth only when
      // there's no per-pixel plate to consult.
      shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
      {
        Gearstack gsR = decodeGearstack( texture2D( uGearstack, vMapUv ) );
        roughnessFactor *= clamp( 1.0 - gsR.smoothness, 0.05, 1.0 );
        // Worn areas are rougher (scratched-up), scaled by the decoded wear mask.
        roughnessFactor = mix( roughnessFactor, min( 1.0, roughnessFactor + 0.35 ), gsR.wear );
        float clothFloorR = uSlotCloth;
        if ( uHasDyeslot > 0.5 ) {
          float qR = floor( texture2D( uDyeslot, vMapUv ).r * 3.0 + 0.5 );
          if ( qR >= 0.5 ) clothFloorR = uCloths[ int( qR ) - 1 ];
        }
        if ( clothFloorR > 0.5 ) {
          // Fabric floor: cloth is never glossy, even if the gearstack green is
          // noisy on a low-res mobile plate.
          roughnessFactor = clamp( roughnessFactor, 0.6, 1.0 );
        }
      }`,
    );

    // Metalness. Two independent per-pixel signals feed this, in priority order:
    //  1. A real dyeslot plate (when present) is the AUTHORITATIVE per-pixel
    //     material-slot mask (see comment above `hasDyeslot`) — far more precise
    //     than the single group-wide slot the material was built with, since one
    //     geometry group's UVs commonly span metal + cloth + leather regions.
    //     Its slot selects uMetalnesses[slot]/uCloths[slot] (the dye's OWN
    //     resolved metalness from pbrFromDetail), and R=0 cells (baked/non-dyed
    //     art per the plate) fall through to the gearstack-decoded metalness.
    //  2. Without a dyeslot plate, fall back to the group-level heuristic: the
    //     gearstack alpha channel only encodes metalness for NON-DYED
    //     (baked-art) pixels (see Gearstack.metalness doc above) — on the
    //     dyeable shell that same alpha band is the dye/wear signal, not
    //     metalness — so only override where dyeMask is 0 (baked trim/buckles);
    //     the dyeable shell keeps the material's base metalness (this group's
    //     single resolved slot).
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <metalnessmap_fragment>",
      `#include <metalnessmap_fragment>
      {
        Gearstack gsM = decodeGearstack( texture2D( uGearstack, vMapUv ) );
        float clothFloorM = uSlotCloth;
        if ( uHasDyeslot > 0.5 ) {
          float qM = floor( texture2D( uDyeslot, vMapUv ).r * 3.0 + 0.5 );
          if ( qM < 0.5 ) {
            metalnessFactor = gsM.metalness;   // baked/non-dyed art
            clothFloorM = 0.0;
          } else {
            int siM = int( qM ) - 1;
            metalnessFactor = uMetalnesses[siM];
            clothFloorM = uCloths[siM];
          }
        } else if ( gsM.dyeMask < 0.5 ) {
          metalnessFactor = gsM.metalness;
        }
        if ( clothFloorM > 0.5 ) metalnessFactor = 0.0;   // fabric is dielectric
      }`,
    );

    // B = emissive (decoded band). Glow colour is per dye slot; select the slot
    // from the dyeslot plate when present, else this part's slot. Modulating by
    // albedo keeps texture patterning visible instead of a flat wash.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      {
        Gearstack egs = decodeGearstack( texture2D( uGearstack, vMapUv ) );
        float glow = egs.emissive;
        vec3 glowTint = vec3( 0.0 );
        float glowOn = 0.0;
        if ( uHasDyeslot > 0.5 ) {
          float eq = floor( texture2D( uDyeslot, vMapUv ).r * 3.0 + 0.5 );
          int esi = eq >= 0.5 ? int( eq ) - 1 : 0;
          glowTint = uPrimEmissives[esi];
          glowOn = 1.0;
        } else if ( uEmissiveOn > 0.5 ) {
          // Only glow when the dye actually specifies an emissive tint. The old
          // fallback lit non-emissive cells in their own albedo colour, which on
          // the gold/white beak seam read as bright white bars.
          glowTint = uEmissiveTint;
          glowOn = 1.0;
        }
        totalEmissiveRadiance += glowTint * glow * glowOn * 1.25;
      }`,
    );
    } // end if (wantGearstack)

    // Live channel viewer — overwrite the final colour with one gearstack
    // channel as greyscale when uDebugChannel is set (see setGearstackDebugChannel
    // above). Runs even when wantGearstack is false, as long as a gearstack map
    // exists, so it's usable on any item that ships one.
    if (maps.gearstack) {
      shader.uniforms.uGearstack = shader.uniforms.uGearstack ?? {
        value: maps.gearstack,
      };
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        if ( uDebugChannel > 0.5 ) {
          vec4 dbgTex = texture2D( uGearstack, vMapUv );
          vec3 dbgChan = uDebugChannel < 1.5 ? vec3( dbgTex.r )
            : uDebugChannel < 2.5 ? vec3( dbgTex.g )
            : uDebugChannel < 3.5 ? vec3( dbgTex.b )
            : vec3( dbgTex.a );
          gl_FragColor = vec4( dbgChan, 1.0 );
        }`,
      );
    }

    mat.userData.shader = shader; // dev aid: live uniform toggling
  };

  return mat;
}

/**
 * One material per geometry group, aligned with `built.groups`.
 * Assign the returned array directly to a `THREE.Mesh` (materials-by-group).
 */
export function createGearMaterials(
  groups: GroupInfo[],
  dyes: DyeSet,
  maps: GearTextureMaps = {},
  opts: GearMaterialOptions = {},
): THREE.Material[] {
  if (groups.length === 0) {
    return [makeOpaque(-1, dyes, maps, opts)];
  }
  return groups.map((g) =>
    g.glow ? makeGlow(maps) : makeOpaque(g.dyeIndex, dyes, maps, opts, g.decal),
  );
}