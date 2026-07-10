"use client";

/**
 * The 3D viewport: a Three.js WebGPU canvas (WebGL2 fallback is automatic)
 * with neutral studio lighting and orbit controls. Node materials (TSL) —
 * which the gear shader is built on — require WebGPURenderer; classic GLSL
 * ShaderMaterials do NOT run here, so scene decorations stick to built-in
 * materials (auto-converted to their node equivalents).
 */
import * as THREE from "three/webgpu";
import {
  Canvas,
  useThree,
  useFrame,
  extend,
  type ThreeToJSXElements,
} from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Suspense, useEffect, useRef } from "react";

declare module "@react-three/fiber" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

// Register the three/webgpu catalogue so JSX elements resolve to the same
// class instances the WebGPURenderer expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
extend(THREE as any);

/**
 * One renderer per canvas. React StrictMode double-mounts the Canvas, and with
 * an ASYNC gl factory both mounts race their own WebGPURenderer onto the same
 * canvas — the loser keeps an animation loop with a stale drawing-buffer size
 * (GPUValidationError: depth attachment 300x150 vs canvas). Sharing the init
 * promise per canvas guarantees a single instance no matter how many times the
 * factory runs. Stored on globalThis (not module scope) so Fast Refresh
 * re-evaluating this module doesn't reset the cache and spawn a zombie
 * renderer that keeps presenting stale frames to the same canvas.
 */
const rendererByCanvas = ((
  globalThis as unknown as {
    __gearRendererByCanvas?: WeakMap<HTMLCanvasElement, Promise<THREE.WebGPURenderer>>;
  }
).__gearRendererByCanvas ??= new WeakMap<
  HTMLCanvasElement,
  Promise<THREE.WebGPURenderer>
>());

function getRenderer(props: unknown): Promise<THREE.WebGPURenderer> {
  const { canvas } = props as { canvas: HTMLCanvasElement };
  let promise = rendererByCanvas.get(canvas);
  if (!promise) {
    const renderer = new THREE.WebGPURenderer({
      ...(props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]),
      antialias: true,
    });
    promise = renderer.init().then(() => renderer);
    rendererByCanvas.set(canvas, promise);
    // Dev aid: expose for console/scene inspection.
    (window as unknown as Record<string, unknown>).__renderer = renderer;
  }
  return promise;
}

/**
 * Keeps the WebGPU renderer's drawing-buffer size in sync with the R3F canvas
 * size. The initial size application races the async backend init — three
 * drops the resize event when the backend isn't ready yet, leaving a stale
 * 300x150 depth buffer (GPUValidationError: depth attachment size mismatch
 * every frame, black canvas) that nothing re-triggers because the size state
 * never changes again. Comparing and re-applying per frame is effectively
 * free and self-heals whatever the init/resize ordering was.
 */
function RendererSizeSync() {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const viewport = useThree((s) => s.viewport);
  const applied = useRef({ w: 0, h: 0, dpr: 0, frames: 0 });
  useFrame(() => {
    const a = applied.current;
    const changed = a.w !== size.width || a.h !== size.height || a.dpr !== viewport.dpr;
    // Empirically the application only sticks once the render loop is live, so
    // re-apply across the first few frames regardless of the change check.
    if (!changed && a.frames > 3) return;
    a.frames++;
    gl.setPixelRatio(viewport.dpr);
    gl.setSize(size.width, size.height, false);
    a.w = size.width;
    a.h = size.height;
    a.dpr = viewport.dpr;
  });
  return null;
}

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
    // The renderer is initialized before R3F hands it over (see getRenderer),
    // so the synchronous fromScene path is safe here.
    const pmrem = new THREE.PMREMGenerator(gl as unknown as THREE.WebGPURenderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = intensity;
    pmrem.dispose();
    return () => {
      scene.environment = null;
      envTex.dispose();
    };
  }, [gl, scene, intensity]);
  return null;
}

export default function ModelViewer({ children }: { children?: React.ReactNode }) {
  return (
    <Canvas
      camera={{ position: [2.4, 1.6, 2.4], fov: 45, near: 0.01, far: 100 }}
      gl={getRenderer}
      style={{ width: "100%", height: "100%", background: "transparent" }}
      dpr={[1, 2]}
    >
      <RendererSizeSync />

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

      {/* drei's <Grid> is a raw-GLSL ShaderMaterial (incompatible with the
          WebGPU renderer) — a plain GridHelper reads the same for a POC. */}
      <gridHelper args={[20, 80, 0x4fd0e0, 0x2b343d]} position={[0, -1.001, 0]} />

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
