/**
 * Builds Three.js materials for a gear mesh, one per geometry group (dye slot).
 *
 * We extend MeshStandardMaterial (so we keep Three's robust PBR lighting) and
 * optionally inject the Destiny "gearstack" logic via onBeforeCompile:
 *
 *   gearstack channels (D2):  R = ambient occlusion
 *                             G = smoothness
 *                             B = alpha test / emissive
 *                             A = dye / metal / wear mask
 *
 * When a gearstack texture is supplied, the dye's primary/secondary tint is
 * blended into the diffuse using the mask (A) and AO/smoothness drive
 * roughness. When it isn't, we fall back to a plain tinted PBR material so a
 * mesh always renders. This keeps the POC robust while leaving the real
 * gearstack path in place to tune empirically.
 */
import * as THREE from "three";
import { dyeForSlot, type DyeSet } from "./gearDye";

export interface GearTextureMaps {
  diffuse?: THREE.Texture;
  normal?: THREE.Texture;
  gearstack?: THREE.Texture;
  /** dedicated glow/illum mask (only some items have one) */
  emissive?: THREE.Texture;
}

export interface GearMaterialOptions {
  /** Apply gearstack AO + smoothness to the PBR response. */
  useGearstack?: boolean;
  /** Tint the albedo with the resolved dye colours (needs real shader/dye data). */
  applyDye?: boolean;
}

function makeOne(
  dyeIndex: number,
  dyes: DyeSet,
  maps: GearTextureMaps,
  opts: GearMaterialOptions,
): THREE.Material {
  // gear_dye_change_color_index -> dye slot (2 indices per slot).
  const slot = dyeIndex >= 0 ? Math.floor(dyeIndex / 2) : 0;
  const dye = dyeForSlot(dyes, slot);

  // Emissive comes from a dedicated glow/illum texture (only some items have
  // one) tinted by the dye's emissive colour. This keeps non-glowing items dark
  // instead of washing the whole mesh in emissive.
  const emissiveTint =
    dye.emissive.r + dye.emissive.g + dye.emissive.b > 0.02
      ? dye.emissive.clone()
      : new THREE.Color(0xffffff);

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

  if (maps.diffuse) maps.diffuse.colorSpace = THREE.SRGBColorSpace;
  if (maps.emissive) maps.emissive.colorSpace = THREE.SRGBColorSpace;

  // Gearstack drives AO + smoothness (needs the diffuse map's UV varying).
  const wantGearstack = opts.useGearstack && !!maps.gearstack && !!maps.diffuse;
  if (wantGearstack) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGearstack = { value: maps.gearstack };
      shader.uniforms.uPrimaryTint = { value: dye.primary };
      shader.uniforms.uApplyDye = { value: opts.applyDye ? 1 : 0 };

      shader.fragmentShader =
        `uniform sampler2D uGearstack;\nuniform vec3 uPrimaryTint;\nuniform float uApplyDye;\n` +
        shader.fragmentShader.replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          {
            vec4 gs = texture2D( uGearstack, vMapUv );
            // R = ambient occlusion -> darken albedo.
            diffuseColor.rgb *= mix( 0.55, 1.0, gs.r );
            // A = dye mask. Tint ONLY the dyeable regions (mask high); regions
            // with baked colour (mask low, e.g. a weapon's painted body) keep
            // their albedo instead of being multiplied dark by the tint.
            if ( uApplyDye > 0.5 ) {
              vec3 tinted = diffuseColor.rgb * uPrimaryTint;
              diffuseColor.rgb = mix( diffuseColor.rgb, tinted, gs.a );
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
        }`,
      );
    };
  }

  return mat;
}

/**
 * One material per geometry group, aligned with `built.groupDyeIndices`.
 * Assign the returned array directly to a `THREE.Mesh` (materials-by-group).
 */
export function createGearMaterials(
  groupDyeIndices: number[],
  dyes: DyeSet,
  maps: GearTextureMaps = {},
  opts: GearMaterialOptions = {},
): THREE.Material[] {
  if (groupDyeIndices.length === 0) {
    return [makeOne(-1, dyes, maps, opts)];
  }
  return groupDyeIndices.map((d) => makeOne(d, dyes, maps, opts));
}
