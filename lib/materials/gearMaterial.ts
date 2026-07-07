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
    metalness: 1,
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

  // Gearstack/detail injection needs the diffuse map's UV varying (vMapUv).
  const wantGearstack = opts.useGearstack && !!maps.gearstack && !!maps.diffuse;
  if (!wantGearstack) return mat;

  const hasDyeslot = !!maps.dyeslot;
  // All three slots' tints (albedo AND glow, per the shader anatomy: each slot
  // = metal/cloth/accent with primary+secondary colour and primary+secondary
  // glow) — the dyeslot plate selects the slot per pixel.
  const primaries = [0, 1, 2].map((s) => dyeForSlot(dyes, s).primary);
  const secondaries = [0, 1, 2].map((s) => dyeForSlot(dyes, s).secondary);
  const primEmissives = [0, 1, 2].map((s) => dyeForSlot(dyes, s).emissive);
  const secEmissives = [0, 1, 2].map((s) => dyeForSlot(dyes, s).secondaryEmissive);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGearstack = { value: maps.gearstack };
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
    shader.uniforms.uPrimEmissives = { value: primEmissives };
    shader.uniforms.uSecEmissives = { value: secEmissives };
    shader.uniforms.uSlotIndex = { value: slot };

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
uniform vec3 uPrimEmissives[3];
uniform vec3 uSecEmissives[3];
` +
      shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          vec4 gs = texture2D( uGearstack, vMapUv );
          // Brightness/saturation for the dye gate, measured on the RAW albedo
          // BEFORE AO darkening — otherwise AO pushes shaded parts of the white
          // panel below the threshold and the gold dye bleeds over them.
          float albLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
          float albSat = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) )
            - min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) );
          // R = ambient occlusion -> darken albedo.
          diffuseColor.rgb *= mix( 1.0, 1.0, gs.r );

          if ( uApplyDye > 0.5 ) {
            // Which dye slot's colours apply here. A per-pixel dyeslot plate
            // (R = 1-based slot index {1/3,2/3,1}) when present; else this
            // part's single slot. R quantizing to 0 = a BAKED region (emblem,
            // glow) — leave its painted colour untouched.
            vec3 pri = uPrimaryTint;
            vec3 sec = uSecondaryTint;
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
              }
            }
            if ( doDye ) {
              if ( uPlated > 0.5 ) {
                // Plate armor: the diffuse is greyscale "change-colour" shell
                // MIXED with baked-colour cells (gold eye, red/white emblem) that
                // must survive. Gate the dye by saturation: near-grey texels take
                // the tint, saturated texels pass through untouched.
                // The nighthawk emblem (white panel + red trim + BLACK hawk) is
                // baked art bounded by the red line — none of it should be dyed.
                // Preserve it by its three signatures so the gold only covers the
                // mid-grey base outside the red line:
                //   * bright  -> white panel + tick marks (sRGB ~224 vs base ~128)
                //   * saturated -> red trim (handled by albSat)
                //   * very dark -> the black hawk (else the brightness gate would
                //     dye it gold and pull the surrounding white down with it)
                // Gate on PRE-AO albedo so AO shading doesn't drop the panel below
                // the line.
                float greyMask = ( 1.0 - smoothstep( 0.06, 0.16, albSat ) )
                  * ( 1.0 - smoothstep( 0.30, 0.48, albLum ) )
                  * smoothstep( 0.04, 0.11, albLum );
                // The gold faceplate (slot 0) reads as its PRIMARY (gold) across
                // the plate — bias toward primary. Other slots use the normal
                // primary(low A)/secondary(high A) split (brown crown, etc.).
                vec3 tint = ( uSlotIndex < 0.5 )
                  ? mix( pri, sec, gs.a * 0.35 )
                  : mix( pri, sec, gs.a );
                vec3 dyed = clamp( diffuseColor.rgb * 1.7, 0.0, 1.1 ) * tint;
                diffuseColor.rgb = mix( diffuseColor.rgb, dyed, greyMask );
              } else {
                // Baked-colour item (weapon): tint only the dye-masked trim and
                // keep the painted body, so the diffuse's own colours survive.
                float dyed = smoothstep( 0.10, 0.25, gs.a );
                float primSel = smoothstep( 0.55, 0.75, gs.a );
                vec3 tint = mix( sec, pri, primSel );
                diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * tint, dyed );
              }
            }
          }
        }`,
      );

    // G = smoothness -> roughness (inverted).
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
      {
        float smoothness = texture2D( uGearstack, vMapUv ).g;
        roughnessFactor *= clamp( 1.0 - smoothness, 0.05, 1.0 );
        if ( uPlated > 0.5 ) {
          if ( uSlotIndex < 0.5 ) {
            // Gold faceplate (slot 0): polished near-mirror metal.
            roughnessFactor = min( roughnessFactor * 0.3, 0.12 );
          } else {
            // Crown (brown leather) + tech: matte — floor the roughness so the
            // brighter environment doesn't turn them glossy.
            roughnessFactor = clamp( roughnessFactor, 0.6, 1.0 );
          }
        }
      }`,
    );

    // Metalness (plate armor): the greyscale ceramic shell is a DIELECTRIC (a
    // flat 0.5 metalness made white armor read grey metal). Only warm/GOLD trim
    // is metallic. Restricting to gold (not just any saturation) keeps the red
    // trim and the antialiased pink emblem edges dielectric — otherwise those
    // edge pixels turn metallic and reflect the scene's coloured lights as
    // green/cyan/magenta specular speckles. Weapons keep their baked metalness.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <metalnessmap_fragment>",
      `#include <metalnessmap_fragment>
      if ( uPlated > 0.5 ) {
        // The gold faceplate (slot 0) is polished METAL — make it fully metallic
        // so it reflects the environment; the painted brown crown / grey slots
        // stay mostly dielectric. Baked WHITE art (emblem panel + ticks) is paint,
        // never metal — force it dielectric so its edges don't throw coloured
        // specular speckles.
        float bright = smoothstep( 0.5, 0.75, dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) );
        float mmx = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) );
        float mmn = min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) );
        // Baked red/coloured trim (saturated, LOW green) is paint, not metal —
        // keep it dielectric so its edges don't spark coloured speckles. Gold
        // (HIGH green) stays metallic.
        float redish = smoothstep( 0.18, 0.4, mmx - mmn ) * ( 1.0 - smoothstep( 0.45, 0.65, diffuseColor.g ) );
        // Only the gold faceplate (slot 0) is real metal; the painted ceramic
        // crown + tech are dielectric.
        float base = ( uSlotIndex < 0.5 ) ? 0.9 : 0.03;
        metalnessFactor = base * ( 1.0 - bright ) * ( 1.0 - redish );
      }`,
    );

    // B = emissive mask (low floor; smoothstep isolates the glowing regions).
    // Glow colour is per dye slot with primary/secondary variants (see shader
    // anatomy: Primary/Secondary Glow), selected exactly like the albedo tints.
    // Modulating by the surface albedo keeps texture patterning visible instead
    // of a flat saturated wash (e.g. Bushido's glowing hood keeps its weave).
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      {
        vec4 egs = texture2D( uGearstack, vMapUv );
        float glow = smoothstep( 0.45, 0.85, egs.b );
        vec3 glowTint;
        if ( uHasDyeslot > 0.5 ) {
          float eq = floor( texture2D( uDyeslot, vMapUv ).r * 3.0 + 0.5 );
          int esi = eq >= 0.5 ? int( eq ) - 1 : 0;
          glowTint = mix( uPrimEmissives[esi], uSecEmissives[esi], egs.a );
        } else {
          glowTint = uEmissiveOn > 0.5 ? uEmissiveTint : diffuseColor.rgb;
        }
        totalEmissiveRadiance += glowTint * glow * 1.25;

        // Some plate cells (e.g. Nighthawk's gold eye) are baked bright glows
        // with NO gearstack emissive mask. Self-illuminate the bright, saturated
        // baked colours that the dye left intact — but ONLY warm/gold ones.
        // Restricting to gold excludes the antialiased pink edges between the
        // white emblem and its red trim, which are bright + saturated but not
        // gold and were blooming as magenta/cyan speckles. Plate armor only.
        if ( uPlated > 0.5 ) {
          float bmx = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) );
          float bmn = min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) );
          float bsat = bmx - bmn;
          float blum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
          // Gold = red & green both high, blue low.
          float warm = min( diffuseColor.r, diffuseColor.g );
          float goldHue = smoothstep( 0.55, 0.8, warm ) * ( 1.0 - smoothstep( 0.35, 0.6, diffuseColor.b ) );
          float bakedGlow = smoothstep( 0.18, 0.4, bsat ) * smoothstep( 0.5, 0.85, blum ) * goldHue;
          // Subtle — the in-game eye is a warm-lit slit, not a bright bloom.
          totalEmissiveRadiance += diffuseColor.rgb * bakedGlow * 0.4;
        }
      }`,
    );

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
