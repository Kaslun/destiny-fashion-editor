"use client";

/**
 * The 3D viewport: a Three.js canvas with neutral studio lighting and orbit
 * controls. Lighting is self-contained (no HDR/network fetch) so it renders
 * reliably offline. Children are the model(s) to display.
 */
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { Suspense } from "react";

export default function ModelViewer({ children }: { children?: React.ReactNode }) {
  return (
    <Canvas
      camera={{ position: [2.4, 1.6, 2.4], fov: 45, near: 0.01, far: 100 }}
      gl={{ antialias: true }}
      style={{ width: "100%", height: "100%", background: "transparent" }}
      dpr={[1, 2]}
    >
      {/* Studio-ish 3-point rig */}
      <hemisphereLight args={[0xbfdfff, 0x1a1f26, 0.8]} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[5, 8, 5]} intensity={1.6} />
      <directionalLight position={[-6, 3, -4]} intensity={0.6} color={0x4fd0e0} />
      <directionalLight position={[0, -4, -6]} intensity={0.4} />

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
