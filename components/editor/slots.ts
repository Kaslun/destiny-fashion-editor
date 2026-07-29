/**
 * The five armor slots the editor dresses, in the order the appearance screen
 * lists them (head down), plus the "overview" pseudo-slot that stands for the
 * whole set. Shared by the slot rail, the overview list and the editor page so
 * they can't drift apart.
 */
import type { SlotKey } from "@/components/viewer/CharacterModel";

/** What the browse column is currently pointed at. */
export type Focus = "overview" | SlotKey;

/** Ornament vs shader — which of a slot's two appearance layers is being edited. */
export type Layer = "gear" | "shader";

export const ARMOR_SLOTS: { key: SlotKey; label: string; glyph: string }[] = [
  { key: "helmet", label: "Helmet", glyph: "◈" },
  { key: "gauntlets", label: "Arms", glyph: "✋" },
  { key: "chest", label: "Chest", glyph: "▣" },
  { key: "legs", label: "Legs", glyph: "⋀" },
  { key: "classItem", label: "Class Item", glyph: "✶" },
];

export const SLOT_LABEL: Record<Focus, string> = {
  overview: "All Armor",
  helmet: "Helmet",
  gauntlets: "Arms",
  chest: "Chest",
  legs: "Legs",
  classItem: "Class Item",
};
