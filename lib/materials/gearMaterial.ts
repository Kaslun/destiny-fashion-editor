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
}

export interface GearMaterialOptions {
  useGearstack?: boolean;
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

  const mat = new THREE.MeshStandardMaterial({
    map: maps.diffuse ?? null,
    normalMap: maps.normal ?? null,
    color: maps.diffuse ? new THREE.Color(0xffffff) : dye.primary.clone(),
    metalness: dye.metalness,
    roughness: dye.roughness,
    side: THREE.DoubleSide, // Destiny meshes aren't always consistently wound
  });

  if (maps.diffuse) maps.diffuse.colorSpace = THREE.SRGBColorSpace;

  const wantGearstack = opts.useGearstack && !!maps.gearstack;
  if (wantGearstack) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGearstack = { value: maps.gearstack };
      shader.uniforms.uPrimaryTint = { value: dye.primary };
      shader.uniforms.uSecondaryTint = { value: dye.secondary };

      shader.fragmentShader =
        `uniform sampler2D uGearstack;\nuniform vec3 uPrimaryTint;\nuniform vec3 uSecondaryTint;\n` +
        shader.fragmentShader.replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          {
            vec4 gs = texture2D( uGearstack, vMapUv );
            // A channel: dye mask. Blend primary tint into masked regions,
            // secondary elsewhere, weighted so untinted detail survives.
            vec3 tint = mix( uSecondaryTint, uPrimaryTint, gs.a );
            diffuseColor.rgb *= tint;
            // R = AO (darken), G = smoothness -> lower roughness handled below.
            diffuseColor.rgb *= mix( 0.6, 1.0, gs.r );
          }`,
        );

      // G channel: smoothness -> roughness. Feed into roughness map slot.
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
