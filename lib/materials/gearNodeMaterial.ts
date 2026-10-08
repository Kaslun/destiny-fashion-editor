import { MeshSSSNodeMaterial, type Node } from "three/webgpu";
import { diffuseColor, metalness, mix, property, specularColor } from "three/tsl";

// r185 does not export this lighting property through three/tsl. Named
// properties share a shader variable by name; avoid importing a second copy
// of Three's internal node implementation from three/src.
const blendedSpecular = property("color", "SpecularColorBlended");

/** D2's odd palette rows contain reflectance, not a tint multiplied by 0.04.
 * Apply that reflectance after Three sets up its ordinary dielectric response.
 * This also avoids r185's unused MeshPhysicalNodeMaterial.specularColorNode.
 */
export class GearNodeMaterial extends MeshSSSNodeMaterial {
  paletteSpecularNode: Node<"vec3"> | null = null;
  paletteSpecularAmountNode: Node<"float"> | null = null;

  override setupSpecular(): void {
    super.setupSpecular();
    if (this.paletteSpecularNode && this.paletteSpecularAmountNode) {
      specularColor.assign(mix(specularColor, this.paletteSpecularNode, this.paletteSpecularAmountNode));
      // Both direct lighting and the environment use the metalness blend.
      blendedSpecular.assign(mix(specularColor, diffuseColor.rgb, metalness));
    }
  }
}
