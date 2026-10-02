// Symbol mode (docs/symbol/SPEC.md §5): one crochet chart symbol per stitch,
// placed by the layout. All strokes are one fat-line mesh (WebGL ignores
// lineWidth above 1), slip-stitch dots one instanced disc mesh, and an
// invisible quad per symbol is what the pointer hits. In 3D a shaded surface
// hides the far side; with it off, symbols facing away fade instead.

import { buildSymbolScene, legendEntries, symbolSvg, type LegendEntry, type PlacedGlyph, type Stitch, type Surface, type SvgOptions, type SymbolScene } from "@crochet-model/core";
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { BuildContext, Layer, PaintState, RowAnchor } from "./layer.ts";
import { BASE_COLOR, HOVER_COLOR, SELECT_COLOR, typeColor, yarnColor } from "./palette.ts";

/** Line width, in yarn units: ink that scales with the model, like paper. */
const LINE_WIDTH = 0.06;
const YARN_PATH_WIDTH = 0.025;
/** How far a far-side symbol is blended into the background (SYM-FR-3.8). */
const FADE = 0.75;
const Z = new THREE.Vector3(0, 0, 1);

export class SymbolLayer implements Layer {
  private scene: SymbolScene | undefined;
  private stitches: Stitch[] = [];
  private baseColors: THREE.Color[] = [];
  /** Per glyph: first segment and segment count in the line mesh; first dot and dot count. */
  private ranges: { seg: number; segs: number; dot: number; dots: number }[] = [];
  private lineColors: Float32Array | undefined;
  private lineGeometry: LineSegmentsGeometry | undefined;
  private dotMesh: THREE.InstancedMesh | undefined;
  private hitMesh: THREE.InstancedMesh | undefined;
  private materials: LineMaterial[] = [];
  /** Per glyph: the centre of its pick quad, where facing is measured. */
  private anchors: THREE.Vector3[] = [];
  private background = new THREE.Color();
  /** 3D with the surface off: paint fades by camera. */
  followsCamera = false;

  /** Called with the legend after every build. */
  onLegend: ((entries: LegendEntry[]) => void) | undefined;

  build({ group, graph, layout, options, cssColor }: BuildContext): void {
    const colorMode = options.colorMode;
    const scene = buildSymbolScene(graph, layout.positions, layout.dimension, { colorMode });
    this.scene = scene;
    const byId = new Map(graph.stitches.map((s) => [s.id, s]));
    this.stitches = scene.glyphs.map((g) => byId.get(g.stitchId)!);
    const ink = cssColor("--ink", "#2a2420");
    const inkAlt = cssColor("--ink-alt", "#2f63a8");
    this.background = cssColor("--card", "#fbf8f1");
    this.baseColors = scene.glyphs.map((g, i) => {
      switch (colorMode) {
        case "yarn":
          return yarnColor(this.stitches[i]!.color);
        case "type":
          return typeColor(g.colorKey);
        case "rows":
          return g.colorKey === "row1" ? inkAlt : ink;
        default:
          return ink;
      }
    });
    this.anchors = scene.glyphs.map((g) => mean(g.hit));
    this.followsCamera = scene.dimension === 3 && !options.surface;
    this.materials = [];

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
    const material = new LineMaterial({ vertexColors: true, worldUnits: true, linewidth: LINE_WIDTH * scene.unit });
    this.materials.push(material);
    group.add(new LineSegments2(geometry, material));

    if (options.yarnPath && scene.yarnPath.length) {
      const path: number[] = [];
      for (const run of scene.yarnPath) for (let i = 1; i < run.length; i++) path.push(...run[i - 1]!, ...run[i]!);
      const pathGeometry = new LineSegmentsGeometry();
      pathGeometry.setPositions(new Float32Array(path));
      const pathMaterial = new LineMaterial({ color: cssColor("--yarn", "#3d64b3"), worldUnits: true, linewidth: YARN_PATH_WIDTH * scene.unit });
      this.materials.push(pathMaterial);
      group.add(new LineSegments2(pathGeometry, pathMaterial));
    }

    if (scene.surface && options.surface) group.add(surfaceMesh(scene.surface, cssColor("--card", "#fbf8f1")));

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

  rowAnchors(): RowAnchor[] {
    return (this.scene?.rowLabels ?? []).map((l) => ({ row: l.row, at: new THREE.Vector3(...l.at), out: new THREE.Vector3(...l.out) }));
  }

  paint({ hover, bases, selected, highlightKey, eye }: PaintState): void {
    const scene = this.scene;
    const colors = this.lineColors;
    if (!scene || !colors || !this.lineGeometry || !this.dotMesh) return;
    const hoverColor = new THREE.Color(HOVER_COLOR);
    const baseColor = new THREE.Color(BASE_COLOR);
    const selectColor = new THREE.Color(SELECT_COLOR);
    const faded = new THREE.Color();
    const toEye = new THREE.Vector3();
    const out = new THREE.Vector3();
    scene.glyphs.forEach((g, i) => {
      const id = g.stitchId;
      let color =
        id === hover?.id || g.key === highlightKey
          ? hoverColor
          : bases.has(id)
            ? baseColor
            : selected.has(id)
              ? selectColor
              : this.baseColors[i]!;
      if (this.followsCamera && out.set(...g.out).dot(toEye.subVectors(eye, this.anchors[i]!)) < 0) {
        color = faded.copy(color).lerp(this.background, FADE);
      }
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

  /** The 2D chart as SVG, in the colours on screen; undefined for 3D (SYM-FR-6.1, 6.3). */
  svg(options: Omit<SvgOptions, "glyphColor">): string | undefined {
    if (!this.scene || this.scene.dimension !== 2) return undefined;
    return symbolSvg(this.scene, { ...options, glyphColor: (i) => `#${this.baseColors[i]!.getHexString()}` });
  }

  resize(width: number, height: number): void {
    for (const m of this.materials) m.resolution.set(width, height);
  }
}

/** Opaque and lit, in the background colour, pushed back so symbols on it always win the depth test. */
function surfaceMesh(surface: Surface, color: THREE.Color): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(surface.vertices.flat()), 3));
  geometry.setIndex(surface.triangles);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 1,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  return new THREE.Mesh(geometry, material);
}

function mean(points: number[][]): THREE.Vector3 {
  const m = new THREE.Vector3();
  for (const p of points) m.add(new THREE.Vector3(p[0], p[1], p[2]));
  return m.divideScalar(Math.max(points.length, 1));
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
