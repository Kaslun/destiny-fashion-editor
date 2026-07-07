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
  // gear_dye_change_color_index -> dye slot. Empirically slot = (cc * 2) % 3 for
  // Nighthawk: cc {0,5,1} on the face / crown / visor -> slots {0,1,2} =
  // gold faceplate / brown crown / grey. (The mobile asset ships no per-pixel
  // dye mask, so the slot is per geometry group.)
  const slot = dyeIndex >= 0 ? (dyeIndex * 2) % 3 : 0;
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

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGearstack = { value: maps.gearstack ?? null };
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
    // Detail-map uniforms.
    shader.uniforms.uDetailDiffuse = { value: detailDiffuse };
    shader.uniforms.uDetailNormal = { value: detailNormal };
    shader.uniforms.uHasDetailDiffuse = { value: hasDetailDiffuse ? 1 : 0 };
    shader.uniforms.uDetailStrength = { value: dye.detailStrength ?? 0 };
    shader.uniforms.uSlotCloth = { value: dye.cloth ? 1 : 0 };
    shader.uniforms.uHasDetailNormal = { value: hasDetailNormal ? 1 : 0 };
    // xy = tiling scale, zw = offset.
    shader.uniforms.uDetailTransform = {
      value: new THREE.Vector4(dt[0], dt[1], dt[2], dt[3]),
    };

    shader.fragmentShader =
      `uniform float uSlotIndex;
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
uniform sampler2D uDetailDiffuse;
uniform sampler2D uDetailNormal;
uniform float uHasDetailDiffuse;
uniform float uDetailStrength;
uniform float uSlotCloth;
uniform float uHasDetailNormal;
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
  g.emissive   = clamp( ( gs.b - 40.0 / 255.0 ) * ( 255.0 / ( 255.0 - 40.0 ) ), 0.0, 1.0 );
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
          // by strength. Gentle range so even full-strength cloth keeps colour.
          float mod = 1.0 + ( dl - 0.5 ) * 0.8 * uDetailStrength;
          diffuseColor.rgb *= mod;
        }`,
      );
    }

    // Detail NORMAL: micro-relief, also weighted by detail strength so flat
    // slots (gold) don't get a woven bump in their reflections.
    if (hasDetailNormal) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        if ( uHasDetailNormal > 0.5 && uDetailStrength > 0.001 ) {
          vec2 dnUv = vMapUv * uDetailTransform.xy + uDetailTransform.zw;
          vec3 dn = texture2D( uDetailNormal, dnUv ).xyz * 2.0 - 1.0;
          normal = normalize( vec3( normal.xy + dn.xy * uDetailStrength, normal.z ) );
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
      shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
      {
        Gearstack gsR = decodeGearstack( texture2D( uGearstack, vMapUv ) );
        roughnessFactor *= clamp( 1.0 - gsR.smoothness, 0.05, 1.0 );
        // Worn areas are rougher (scratched-up), scaled by the decoded wear mask.
        roughnessFactor = mix( roughnessFactor, min( 1.0, roughnessFactor + 0.35 ), gsR.wear );
        if ( uSlotCloth > 0.5 ) {
          // Fabric floor: cloth is never glossy, even if the gearstack green is
          // noisy on a low-res mobile plate.
          roughnessFactor = clamp( roughnessFactor, 0.6, 1.0 );
        }
      }`,
    );

    // Metalness — now sourced from the gearstack alpha channel (decoded), which
    // is Bungie's authoritative per-pixel non-dyed metalness. This replaces the
    // previous gold-hue/saturation heuristic that guessed metal from albedo
    // colour (and threw coloured specular speckles on antialiased emblem edges).
    // Cloth slots are forced dielectric regardless (fabric is never metal).
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <metalnessmap_fragment>",
      `#include <metalnessmap_fragment>
      {
        Gearstack gsM = decodeGearstack( texture2D( uGearstack, vMapUv ) );
        float m = gsM.metalness;
        if ( uSlotCloth > 0.5 ) m = 0.0;   // fabric is dielectric
        metalnessFactor = m;
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
        vec3 glowTint;
        if ( uHasDyeslot > 0.5 ) {
          float eq = floor( texture2D( uDyeslot, vMapUv ).r * 3.0 + 0.5 );
          int esi = eq >= 0.5 ? int( eq ) - 1 : 0;
          glowTint = uPrimEmissives[esi];
        } else {
          glowTint = uEmissiveOn > 0.5 ? uEmissiveTint : diffuseColor.rgb;
        }
        totalEmissiveRadiance += glowTint * glow * 1.25;
      }`,
    );
    } // end if (wantGearstack)

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