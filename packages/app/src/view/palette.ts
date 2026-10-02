// Colours shared by the structure and symbol layers.

import { baseType } from "@crochet-model/core";
import * as THREE from "three";

// Stitch-type palette for "type" mode; types not listed get a hash colour.
const TYPE_COLORS: Record<string, string> = {
  ch: "#8a8f98",
  ss: "#b0a58f",
  sc: "#4c8bd6",
  hdc: "#3aa5a0",
  dc: "#d68a3c",
  tr: "#b8568f",
  ring: "#6d6860",
  hidden: "#6d6860",
};

// Hover highlights; kept off the usual yarn colours.
export const HOVER_COLOR = "#ff3fd2";
export const BASE_COLOR = "#2fbf71";
/** Stitches of the row selected in the review (FR-3.2). */
export const SELECT_COLOR = "#ffb000";

/** The type palette colours the stitch height: "scbl" and "fpsc" are "sc". */
export function typeColor(type: string): THREE.Color {
  const base = baseType(type);
  return new THREE.Color(TYPE_COLORS[base] ?? hashColor(base));
}

/** A COLOR: value, or CrochetPARADE's grey when there is none or it is not a CSS colour. */
export function yarnColor(color: string | undefined): THREE.Color {
  const out = new THREE.Color(0x969696);
  if (color) {
    try {
      out.setStyle(color);
    } catch {
      // Not a CSS colour: keep the default grey, as CrochetPARADE does.
    }
  }
  return out;
}

function hashColor(text: string): THREE.Color {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55);
}
