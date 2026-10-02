// What ModelView asks of a level of detail (structure, symbols): build its
// meshes into a group, say which stitch is under the pointer, and recolour
// for hover, selection and legend highlights without rebuilding.

import type { LayoutResult, Stitch, StitchGraph } from "@crochet-model/core";
import type * as THREE from "three";

export type ViewMode = "structure" | "symbols";
/** "ink" and "rows" are for symbols; structure mode treats them as "yarn". */
export type ColorMode = "yarn" | "type" | "ink" | "rows";

export interface ViewOptions {
  mode: ViewMode;
  colorMode: ColorMode;
  /** Structure mode: show internal nodes (puffs, loop and chain-space nodes) and the gray edges that place them. */
  showInternal: boolean;
  /** Symbols, 3D: a shaded surface under the symbols (SYM-FR-3.8). With it off, far-side symbols fade. */
  surface: boolean;
  /** Symbols: a thin line along the yarn from stitch to stitch (SYM-FR-4.6). */
  yarnPath: boolean;
  /** Symbols: each row's number by its first stitch (SYM-FR-4.6). */
  rowNumbers: boolean;
}

/** A row number to place over the canvas. */
export interface RowAnchor {
  row: number;
  at: THREE.Vector3;
  /** Hidden while this faces away from the camera. */
  out: THREE.Vector3;
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
  /** The camera position, for layers that fade what faces away from it. */
  eye: THREE.Vector3;
}

export interface Layer {
  build(ctx: BuildContext): void;
  stitchAt(raycaster: THREE.Raycaster): Stitch | undefined;
  paint(state: PaintState): void;
  /** The canvas size in pixels, for screen-space materials. */
  resize?(width: number, height: number): void;
  /** True when paint() depends on the camera, so orbiting repaints. */
  readonly followsCamera?: boolean;
  /** Row numbers to show, when asked for. */
  rowAnchors?(): RowAnchor[];
}
