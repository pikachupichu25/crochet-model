// What ModelView asks of a level of detail (structure, symbols): build its
// meshes into a group, say which stitch is under the pointer, and recolour
// for hover, selection and legend highlights without rebuilding.

import type { LayoutResult, Stitch, StitchGraph } from "@crochet-model/core";
import type * as THREE from "three";

export type ViewMode = "structure" | "symbols";
/** "ink" is for symbols; structure mode treats it as "yarn". */
export type ColorMode = "yarn" | "type" | "ink";

export interface ViewOptions {
  mode: ViewMode;
  colorMode: ColorMode;
  /** Structure mode: show internal nodes (puffs, loop and chain-space nodes) and the gray edges that place them. */
  showInternal: boolean;
}

export interface BuildContext {
  group: THREE.Group;
  graph: StitchGraph;
  layout: LayoutResult;
  options: ViewOptions;
  /** A CSS custom property of the view's container, as a colour. */
  cssColor(name: string, fallback: string): THREE.Color;
}

export interface PaintState {
  hover?: Stitch;
  /** The stitches the hovered one is worked into. */
  bases: Set<string>;
  selected: Set<string>;
  /** Symbols: a legend entry being hovered. */
  highlightKey?: string;
}

export interface Layer {
  build(ctx: BuildContext): void;
  stitchAt(raycaster: THREE.Raycaster): Stitch | undefined;
  paint(state: PaintState): void;
  /** The canvas size in pixels, for screen-space materials. */
  resize?(width: number, height: number): void;
}
