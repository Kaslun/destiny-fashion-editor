import { describe, expect, it } from "vitest";
import { MeshSSSNodeMaterial, type Node } from "three/webgpu";
import { float, getCurrentStack, setCurrentStack, stack, vec3 } from "three/tsl";
import { GearNodeMaterial } from "./gearNodeMaterial";

function specularFlow(material: MeshSSSNodeMaterial) {
  const flow = stack(), previous = getCurrentStack();
  setCurrentStack(flow);
  try { material.setupSpecular(); } finally { setCurrentStack(previous); }
  return flow.nodes;
}

function writes(nodes: Node[]) {
  return nodes.flatMap((n) => {
    const target = (n as Node & { targetNode?: { name?: string } }).targetNode;
    return target?.name ? [target.name] : [];
  });
}

describe("palette reflectance in Three's physical lighting flow", () => {
  it("preserves the standard specular flow when no palette is supplied", () => {
    expect(writes(specularFlow(new GearNodeMaterial())))
      .toEqual(writes(specularFlow(new MeshSSSNodeMaterial())));
  });

  it("actually consumes the palette and updates the reflection used by direct and environment lighting", () => {
    const material = new GearNodeMaterial();
    const palette = vec3(0.2, 0.05, 0.6);
    material.paletteSpecularNode = palette;
    material.paletteSpecularAmountNode = float(0.8);
    const nodes = specularFlow(material);
    let consumed = false;
    for (const n of nodes) n.traverse((child) => { if (child === palette) consumed = true; });
    expect(consumed).toBe(true);
    const targets = writes(nodes);
    // Both properties are used by the installed renderer. Merely assigning
    // MeshPhysicalNodeMaterial.specularColorNode did not put it in this flow.
    expect(targets.filter((n) => n === "SpecularColorBlended")).toHaveLength(2);
    expect(targets.slice(-2)).toEqual(["SpecularColor", "SpecularColorBlended"]);
  });
});
