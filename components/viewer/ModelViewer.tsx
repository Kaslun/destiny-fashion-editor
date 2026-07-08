"use client";

/**
 * The 3D viewport: a Three.js canvas with neutral studio lighting and orbit
 * controls. Lighting is self-contained (no HDR/network fetch) so it renders
 * reliably offline. Children are the model(s) to display.
 */
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Suspense, useEffect } from "react";


/**
 * Smooth studio IBL for metals. Metallic surfaces (gold trim/visors) reflect
 * their surroundings — with only sharp coloured point lights and no environment
 * they produce firefly specular speckles (metal × coloured light = green/cyan
 * confetti along edges). A low-intensity PMREM of RoomEnvironment gives them a
 * smooth neutral reflection instead. Generated locally (no HDR/network fetch).
 */
function StudioEnvironment({ intensity = 1 }: { intensity?: number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = intensity;
    return () => {
      scene.environment = null;
      envTex.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, intensity]);
  return null;
}

export default function ModelViewer({ children }: { children?: React.ReactNode }) {
  return (
    <Canvas
      camera={{ position: [2.4, 1.6, 2.4], fov: 45, near: 0.01, far: 100 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ width: "100%", height: "100%", background: "transparent" }}
      dpr={[1, 2]}
    >
      {/* Smooth IBL so metals reflect a neutral studio, not firefly speculars */}
      <StudioEnvironment intensity={1} />

      {/* Studio-ish 3-point rig. The key/fill are neutral-white to avoid tinting
          metallic speculars; the cool accent is kept subtle. */}
      <hemisphereLight args={[0xd8e4f0, 0x20242a, 0.55]} />
      <ambientLight intensity={0.2} />
      <directionalLight position={[5, 8, 5]} intensity={1.5} />
      <directionalLight position={[-6, 3, -4]} intensity={0.45} />
      <directionalLight position={[0, -4, -6]} intensity={0.35} />

      <Suspense fallback={null}>{children}</Suspense>

      <Grid
        args={[20, 20]}
        cellSize={0.25}
        cellColor="#2b343d"
        sectionSize={1}
        sectionColor="#4fd0e0"
        fadeDistance={14}
        fadeStrength={1.5}
        infiniteGrid
        position={[0, -1.001, 0]}
      />

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={0.6}
        maxDistance={12}
        target={[0, 0, 0]}
      />
    </Canvas>
  );
}
