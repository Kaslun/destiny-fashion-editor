import type { Group, Texture } from "three";

type Disposable = { dispose(): void };

/** One owner per model load, including resources never attached to a mesh. */
export class ModelResources {
  private resources = new Set<Disposable>();
  private released = new WeakSet<Disposable>();
  private images = new WeakSet<object>();
  private closed = false;

  own<T extends Disposable>(resource: T): T {
    if (this.closed) this.release(resource);
    else this.resources.add(resource);
    return resource;
  }

  private release(resource: Disposable) {
    if (this.released.has(resource)) return;
    this.released.add(resource);
    resource.dispose();
    const texture = resource as Texture;
    const image = (texture.isTexture ? texture.image : null) as { close?: () => void } | null;
    if (image && typeof image.close === "function" && !this.images.has(image)) {
      this.images.add(image);
      image.close();
    }
  }

  dispose = () => {
    this.closed = true;
    for (const resource of this.resources) this.release(resource);
    this.resources.clear();
  };
}

const owners = new WeakMap<Group, ModelResources>();
export function ownModel(group: Group, resources: ModelResources) {
  owners.set(group, resources);
}
export function disposeModel(group: Group) {
  owners.get(group)?.dispose();
  owners.delete(group);
  group.removeFromParent();
  group.clear();
}
