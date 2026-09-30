"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { pass, mrt, output, emissive, vec4, clamp, max } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

/** Shared by the editor and POC. Only emitted light blooms: white paint,
 * reflections and the grid are excluded. Combine in HDR before tone mapping.
 */
export default function EmissionBloom({ raw }: { raw: boolean }) {
  const { gl, scene, camera } = useThree();
  const renderer = gl as unknown as THREE.WebGPURenderer;
  const pipeline = useRef<THREE.RenderPipeline | null>(null);

  useEffect(() => {
    const scenePass = pass(scene, camera);
    const attachments = mrt({ output, emissive: vec4(emissive, output.a) });
    // Extra attachments otherwise default to NO blending: transparent carrier
    // rectangles would bloom even where their symbol/ray opacity is zero.
    attachments.setBlendMode("emissive", new THREE.BlendMode(THREE.MaterialBlending));
    scenePass.setMRT(attachments);
    // Half-float preserves colored energy above 1, including transparent VFX.
    const light = scenePass.getTextureNode("emissive");
    const beauty = scenePass.getTextureNode("output");
    const halo = bloom(light, 0.65, 0.2, 0.05);
    const renderPipeline = new THREE.RenderPipeline(renderer);
    // Keep the canvas transparent while allowing halos outside the silhouette.
    const coverage = clamp(beauty.a.add(max(max(halo.r, halo.g), halo.b)), 0, 1);
    renderPipeline.outputNode = raw ? beauty : vec4(beauty.rgb.add(halo.rgb), coverage);
    pipeline.current = renderPipeline;
    return () => {
      pipeline.current = null;
      renderPipeline.dispose();
      halo.dispose();
      scenePass.dispose();
    };
  }, [renderer, scene, camera, raw]);

  // Positive priority owns the final render after animation and size sync.
  // Debug channels bypass blur/compositing but retain the same MRT layout:
  // unlit effects still write an emission attachment even during inspection.
  useFrame(() => {
    pipeline.current?.render();
  }, 1);
  return null;
}
