// Symbol mode (docs/symbol/SPEC.md §5): one crochet chart symbol per stitch,
// placed by the layout. All strokes are one fat-line mesh (WebGL ignores
// lineWidth above 1), slip-stitch dots one instanced disc mesh, and an
// invisible quad per symbol is what the pointer hits.

import { buildSymbolScene, legendEntries, type LegendEntry, type PlacedGlyph, type Stitch, type SymbolScene } from "@crochet-model/core";
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { BuildContext, Layer, PaintState } from "./layer.ts";
import { BASE_COLOR, HOVER_COLOR, SELECT_COLOR, typeColor, yarnColor } from "./palette.ts";

/** Line width, in yarn units: ink that scales with the model, like paper. */
const LINE_WIDTH = 0.06;
const Z = new THREE.Vector3(0, 0, 1);

export class SymbolLayer implements Layer {
  private scene: SymbolScene | undefined;
  private stitches: Stitch[] = [];
  private baseColors: THREE.Color[] = [];
  /** Per glyph: first segment and segment count in the line mesh; first dot and dot count. */
  private ranges: { seg: number; segs: number; dot: number; dots: number }[] = [];
  private lineColors: Float32Array | undefined;
  private lineGeometry: LineSegmentsGeometry | undefined;
  private material: LineMaterial | undefined;
  private dotMesh: THREE.InstancedMesh | undefined;
  private hitMesh: THREE.InstancedMesh | undefined;

  /** Called with the legend after every build. */
  onLegend: ((entries: LegendEntry[]) => void) | undefined;

  build({ group, graph, layout, options, cssColor }: BuildContext): void {
    const colorMode = options.colorMode;
    const scene = buildSymbolScene(graph, layout.positions, layout.dimension, { colorMode });
    this.scene = scene;
    const byId = new Map(graph.stitches.map((s) => [s.id, s]));
    this.stitches = scene.glyphs.map((g) => byId.get(g.stitchId)!);
    const ink = cssColor("--ink", "#2a2420");
    this.baseColors = scene.glyphs.map((g, i) =>
      colorMode === "ink" ? ink : colorMode === "yarn" ? yarnColor(this.stitches[i]!.color) : typeColor(g.colorKey),
    );

    // Lines: every polyline as segments, glyph by glyph.
    const positions: number[] = [];
    let dotCount = 0;
    this.ranges = scene.glyphs.map((g) => {
      const seg = positions.length / 6;
      for (const line of g.lines)
        for (let i = 1; i < line.length; i++) positions.push(...line[i - 1]!, ...line[i]!);
      const range = { seg, segs: positions.length / 6 - seg, dot: dotCount, dots: g.dots.length };
      dotCount += g.dots.length;
      return range;
    });
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(positions));
    this.lineColors = new Float32Array(positions.length);
    geometry.setColors(this.lineColors);
    this.lineGeometry = geometry;
    this.material = new LineMaterial({ vertexColors: true, worldUnits: true, linewidth: LINE_WIDTH * scene.unit });
    group.add(new LineSegments2(geometry, this.material));

    // Slip-stitch dots: flat discs facing out of the fabric.
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const dots = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 12), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), Math.max(dotCount, 1));
    dots.count = dotCount;
    scene.glyphs.forEach((g, i) =>
      g.dots.forEach((d, k) => {
        q.setFromUnitVectors(Z, v.set(...g.out));
        m.compose(new THREE.Vector3(...d.at), q, new THREE.Vector3(d.radius, d.radius, d.radius));
        dots.setMatrixAt(this.ranges[i]!.dot + k, m);
      }),
    );
    this.dotMesh = dots;
    group.add(dots);

    // Pick quads, never drawn.
    const hits = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
      Math.max(scene.glyphs.length, 1),
    );
    hits.count = scene.glyphs.length;
    scene.glyphs.forEach((g, i) => hits.setMatrixAt(i, quadMatrix(g)));
    this.hitMesh = hits;
    group.add(hits);

    this.onLegend?.(legendEntries(scene));
  }

  stitchAt(raycaster: THREE.Raycaster): Stitch | undefined {
    if (!this.hitMesh) return undefined;
    const hit = raycaster.intersectObject(this.hitMesh, false)[0];
    return hit?.instanceId !== undefined ? this.stitches[hit.instanceId] : undefined;
  }

  paint({ hover, bases, selected, highlightKey }: PaintState): void {
    const scene = this.scene;
    const colors = this.lineColors;
    if (!scene || !colors || !this.lineGeometry || !this.dotMesh) return;
    const hoverColor = new THREE.Color(HOVER_COLOR);
    const baseColor = new THREE.Color(BASE_COLOR);
    const selectColor = new THREE.Color(SELECT_COLOR);
    scene.glyphs.forEach((g, i) => {
      const id = g.stitchId;
      const color =
        id === hover?.id || g.key === highlightKey
          ? hoverColor
          : bases.has(id)
            ? baseColor
            : selected.has(id)
              ? selectColor
              : this.baseColors[i]!;
      const { seg, segs, dot, dots } = this.ranges[i]!;
      for (let k = seg * 6; k < (seg + segs) * 6; k += 3) {
        colors[k] = color.r;
        colors[k + 1] = color.g;
        colors[k + 2] = color.b;
      }
      for (let k = 0; k < dots; k++) this.dotMesh!.setColorAt(dot + k, color);
    });
    const attribute = this.lineGeometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
    attribute.data.needsUpdate = true;
    if (this.dotMesh.instanceColor) this.dotMesh.instanceColor.needsUpdate = true;
  }

  resize(width: number, height: number): void {
    this.material?.resolution.set(width, height);
  }
}

/** Maps the unit plane onto a glyph's pick quad. */
function quadMatrix(g: PlacedGlyph): THREE.Matrix4 {
  const [c0, c1, , c3] = g.hit.map((p) => new THREE.Vector3(...p));
  const x = c1!.clone().sub(c0!);
  const y = c3!.clone().sub(c0!);
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const center = c0!.clone().add(x.clone().multiplyScalar(0.5)).add(y.clone().multiplyScalar(0.5));
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(center);
}
