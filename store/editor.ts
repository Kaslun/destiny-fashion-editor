"use client";

/**
 * Editor state (Zustand). Stub for now — the manual-mode editor UI (build step
 * #3) fills these out. Kept minimal so the POC compiles against the shape the
 * real editor will use: an item per armor/weapon slot, per-item shader
 * assignments, and weapon visibility toggles.
 */
import { create } from "zustand";

export type ArmorSlot = "helmet" | "gauntlets" | "chest" | "legs" | "classItem";
export type WeaponSlot = "kinetic" | "energy" | "power";

export interface SlotSelection {
  itemHash: number | null;
  shaderHash: number | null;
  ornamentHash: number | null;
}

const emptySelection: SlotSelection = {
  itemHash: null,
  shaderHash: null,
  ornamentHash: null,
};

interface EditorState {
  armor: Record<ArmorSlot, SlotSelection>;
  weapons: Record<WeaponSlot, SlotSelection>;
  weaponVisible: Record<WeaponSlot, boolean>;

  setArmorItem: (slot: ArmorSlot, itemHash: number | null) => void;
  setArmorShader: (slot: ArmorSlot, shaderHash: number | null) => void;
  setWeaponItem: (slot: WeaponSlot, itemHash: number | null) => void;
  toggleWeaponVisible: (slot: WeaponSlot) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  armor: {
    helmet: { ...emptySelection },
    gauntlets: { ...emptySelection },
    chest: { ...emptySelection },
    legs: { ...emptySelection },
    classItem: { ...emptySelection },
  },
  weapons: {
    kinetic: { ...emptySelection },
    energy: { ...emptySelection },
    power: { ...emptySelection },
  },
  weaponVisible: { kinetic: true, energy: true, power: true },

  setArmorItem: (slot, itemHash) =>
    set((s) => ({ armor: { ...s.armor, [slot]: { ...s.armor[slot], itemHash } } })),
  setArmorShader: (slot, shaderHash) =>
    set((s) => ({ armor: { ...s.armor, [slot]: { ...s.armor[slot], shaderHash } } })),
  setWeaponItem: (slot, itemHash) =>
    set((s) => ({ weapons: { ...s.weapons, [slot]: { ...s.weapons[slot], itemHash } } })),
  toggleWeaponVisible: (slot) =>
    set((s) => ({
      weaponVisible: { ...s.weaponVisible, [slot]: !s.weaponVisible[slot] },
    })),
}));
