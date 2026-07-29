/**
 * Tone-mapping choices for the viewport, as semantic keys rather than three's
 * numeric constants.
 *
 * Deliberately three-free: the debug panel that renders these buttons is part
 * of the editor's own bundle, while three (and the renderer) live behind the
 * dynamic `ModelViewer` import. Importing three here just to name three
 * constants would pull the whole core library out of that lazy chunk and into
 * the editor's initial payload, for a dev-only control. ModelViewer maps these
 * keys onto the real THREE.* constants — see TONE_MAPPING_BY_KEY there.
 *
 * Why this is a control at all: R3F sets ACESFilmicToneMapping on the renderer
 * (it does NOT leave three's NoToneMapping default alone), so the whole render
 * has been going through a film-emulation S-curve that nobody picked, and every
 * material default tuned by eye was tuned against it. Measured across two sets
 * (see docs/SHADER-DEBUG-SWEEP.md), ACES and Neutral agree across the muted
 * bulk of a Guardian and diverge by up to 131/255 on bright, saturated and
 * emissive regions — so this needs to be A/B-able live while materials are
 * re-tuned, not settled once from a screenshot.
 */
export type ToneMappingKey = "aces" | "neutral" | "none";

export const TONE_MAPPING_OPTIONS: {
  key: ToneMappingKey;
  label: string;
  note: string;
}[] = [
  {
    key: "aces",
    label: "ACES",
    note: "Film-emulation S-curve. Desaturates and rolls highlights off hard. R3F's default — inherited, not chosen.",
  },
  {
    key: "neutral",
    label: "Neutral",
    note: "Khronos PBR Neutral: built to preserve authored albedo, with a gentle highlight roll-off. Runs darker than ACES; expect to want an exposure bump.",
  },
  {
    key: "none",
    label: "None",
    note: "Linear straight to sRGB. Most literal, but nothing tames values above 1.0, so speculars clip (0.26% of a saturated set already blown).",
  },
];

/**
 * Unchanged from what the app has actually been rendering with, so adding this
 * control changes nothing until someone picks a different option. Switching the
 * default is a separate, deliberate decision — see the recommendation in
 * docs/SHADER-DEBUG-SWEEP.md.
 */
export const DEFAULT_TONE_MAPPING: ToneMappingKey = "aces";
