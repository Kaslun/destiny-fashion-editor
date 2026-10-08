import { describe, expect, it, vi } from "vitest";
import { BufferGeometry, Group, Mesh, MeshBasicMaterial, Texture } from "three";
import { ModelResources, ownModel, disposeModel } from "./resources";

describe("model resource ownership", () => {
  it("releases shared, unattached and late resources exactly once", () => {
    const owner = new ModelResources();
    const image = { close: vi.fn() };
    const texture = new Texture(image);
    const disposed = vi.fn();
    texture.addEventListener("dispose", disposed);
    owner.own(texture);
    owner.own(texture); // one texture may dress many meshes
    const detail = owner.own(new Texture(image));
    const detailDisposed = vi.fn();
    detail.addEventListener("dispose", detailDisposed);
    owner.dispose();
    owner.dispose();
    owner.own(texture); // a cancelled decoder can resolve after cleanup
    const late = { dispose: vi.fn() };
    owner.own(late);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(detailDisposed).toHaveBeenCalledTimes(1);
    expect(image.close).toHaveBeenCalledTimes(1);
    expect(late.dispose).toHaveBeenCalledTimes(1);
  });

  it("repeated swaps return owned resource counts to zero without touching another model", () => {
    const parent = new Group();
    const other = new ModelResources();
    const retained = { dispose: vi.fn() };
    other.own(retained);
    for (let i = 0; i < 30; i++) {
      const owner = new ModelResources();
      const geometry = owner.own(new BufferGeometry());
      const material = owner.own(new MeshBasicMaterial());
      const texture = owner.own(new Texture());
      let live = 3;
      for (const r of [geometry, material, texture]) r.addEventListener("dispose", () => live--);
      const group = new Group();
      group.add(new Mesh(geometry, material), new Mesh(geometry, material));
      ownModel(group, owner);
      parent.add(group);
      disposeModel(group);
      disposeModel(group);
      expect(live).toBe(0);
      expect(parent.children).toHaveLength(0);
    }
    expect(retained.dispose).not.toHaveBeenCalled();
    other.dispose();
  });
});
