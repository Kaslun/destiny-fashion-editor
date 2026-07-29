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
import { DEFAULT_TONE_MAPPING, type ToneMappingKey } from "./toneMapping";

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
 * Keeps the WebGPU renderer's drawing-buffer size — and the camera's aspect —
 * in sync with the R3F canvas size. The initial size application races the
 * async backend init — three drops the resize event when the backend isn't
 * ready yet, leaving a stale 300x150 depth buffer (GPUValidationError: depth
 * attachment size mismatch every frame, black canvas) that nothing re-triggers
 * because the size state never changes again. Comparing and re-applying per
 * frame is effectively free and self-heals whatever the init/resize ordering
 * was.
 *
 * The same race hits the default camera: R3F derives `aspect` from the first
 * measurement, which can be a 0-width container before layout settles. That
 * leaves aspect 0 — an Infinity projection matrix that draws the scene into
 * nothing — and it never recovers, because the size state that would fix it
 * never changes again either. Hence the per-frame compare here too.
 */
function RendererSizeSync() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const viewport = useThree((s) => s.viewport);
  const applied = useRef({ w: 0, h: 0, dpr: 0, frames: 0 });
  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera && size.width > 0 && size.height > 0) {
      const aspect = size.width / size.height;
      if (Math.abs(cam.aspect - aspect) > 1e-6) {
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
      }
    }

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
 * Bypass tone mapping while a gearstack debug channel is active.
 *
 * The debug channels replace the fragment output with a RAW value (a gearstack
 * channel, or a categorical slot/band colour) — their whole job is to be read
 * numerically off the screen. But tone mapping and the output colour-space
 * encode are applied by the WebGPU renderer as a full-screen post pass over
 * the whole frame ("Output Color Transform"), after every material's
 * outputNode, and `material.toneMapped` is honoured only by the legacy
 * WebGLRenderer — so a material cannot opt out of it. The colour-space half is
 * pre-inverted in the shader (see colorSpaceToWorking in gearMaterial.ts); the
 * tone curve has to be switched off at the renderer, which is what this does.
 *
 * It matters more than it looks: R3F does NOT leave three's `NoToneMapping`
 * default in place — it sets ACESFilmicToneMapping on the renderer, a strong
 * artistic S-curve. Measured on the undyed-grey debug constant vec3(0.15):
 * with ACES on it reached the screen as 20/255 (0.078) instead of 38/255
 * (0.15), i.e. read as less than half its real value.
 *
 * Only the debug views are forced — the normal render (channel 0) uses whatever
 * curve the `toneMapping` prop selects, so the dev drawer can A/B ACES vs
 * Neutral vs none live while materials are re-tuned. R3F sets ACES on the
 * renderer at construction, which is why "inherited" is not a safe baseline to
 * restore to; the prop is the single source of truth instead.
 */
const TONE_MAPPING_BY_KEY: Record<ToneMappingKey, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.NoToneMapping,
};

function DebugToneMapping({
  raw,
  toneMapping,
}: {
  raw: boolean;
  toneMapping: ToneMappingKey;
}) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  useEffect(() => {
    gl.toneMapping = raw
      ? THREE.NoToneMapping
      : (TONE_MAPPING_BY_KEY[toneMapping] ?? THREE.ACESFilmicToneMapping);
  }, [gl, raw, toneMapping]);
  return null;
}

/**
 * Dev aid: expose the camera and orbit controls for console/scene inspection,
 * alongside the renderer handle set in getRenderer. Neither is reachable from
 * outside the Canvas otherwise, which makes framing bugs painful to diagnose.
 */
function SceneDevAids() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__camera = camera;
    w.__controls = controls;
  }, [camera, controls]);
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

/**
 * Named lighting rigs. "studio" is the neutral reference (key/fill are white so
 * metallic speculars aren't tinted); the other two are stage moods — a warm
 * Tower afternoon and a cold night — and only ever change light colour/level,
 * never the gear materials, so a piece tuned under studio still reads true.
 */
export type LightPreset = "studio" | "tower" | "night";

const RIGS: Record<
  LightPreset,
  {
    hemi: [number, number, number];
    ambient: number;
    key: [number, number];
    fill: [number, number];
    rim: [number, number];
    env: number;
  }
> = {
  studio: {
    hemi: [0xd8e4f0, 0x20242a, 0.55],
    ambient: 0.2,
    key: [0xffffff, 1.5],
    fill: [0xffffff, 0.45],
    rim: [0xffffff, 0.35],
    env: 1,
  },
  tower: {
    hemi: [0xf2e0c4, 0x2a2620, 0.5],
    ambient: 0.18,
    key: [0xffd9a3, 1.6],
    fill: [0xbcd0e8, 0.4],
    rim: [0xffc98a, 0.4],
    env: 0.9,
  },
  night: {
    hemi: [0x4a5a72, 0x0e1116, 0.35],
    ambient: 0.1,
    key: [0xaecbff, 0.75],
    fill: [0x7f9bc4, 0.28],
    rim: [0xd8e8ff, 0.5],
    env: 0.4,
  },
};

export default function ModelViewer({
  children,
  light = "studio",
  showGrid = true,
  rawOutput = false,
  toneMapping = DEFAULT_TONE_MAPPING,
}: {
  children?: React.ReactNode;
  light?: LightPreset;
  /** The POC wants a ground reference; the editor's stage is a clean backdrop. */
  showGrid?: boolean;
  /**
   * True while a gearstack debug channel is active — drops tone mapping so the
   * debug views read as raw values. See DebugToneMapping.
   */
  rawOutput?: boolean;
  /** Tone curve for the normal render; ignored while `rawOutput` is set. */
  toneMapping?: ToneMappingKey;
}) {
  const rig = RIGS[light] ?? RIGS.studio;
  return (
    <Canvas
      camera={{ position: [2.4, 1.6, 2.4], fov: 45, near: 0.01, far: 100 }}
      gl={getRenderer}
      style={{ width: "100%", height: "100%", background: "transparent" }}
      dpr={[1, 2]}
    >
      <RendererSizeSync />
      <SceneDevAids />
      <DebugToneMapping raw={rawOutput} toneMapping={toneMapping} />

      {/* Smooth IBL so metals reflect a neutral studio, not firefly speculars */}
      <StudioEnvironment intensity={rig.env} />

      {/* Studio-ish 3-point rig. */}
      <hemisphereLight args={rig.hemi} />
      <ambientLight intensity={rig.ambient} />
      <directionalLight position={[5, 8, 5]} color={rig.key[0]} intensity={rig.key[1]} />
      <directionalLight position={[-6, 3, -4]} color={rig.fill[0]} intensity={rig.fill[1]} />
      <directionalLight position={[0, -4, -6]} color={rig.rim[0]} intensity={rig.rim[1]} />

      <Suspense fallback={null}>{children}</Suspense>

      {/* drei's <Grid> is a raw-GLSL ShaderMaterial (incompatible with the
          WebGPU renderer) — a plain GridHelper reads the same for a POC. */}
      {showGrid && (
        <gridHelper args={[20, 80, 0x4fd0e0, 0x2b343d]} position={[0, -1.001, 0]} />
      )}

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
