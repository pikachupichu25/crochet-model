// Structure mode (SPEC.md §6.5): a ball-and-stick view of a laid-out stitch
// graph. Stitches are spheres, edges are cylinders; both are instanced, so a
// few thousand stitches cost two draw calls per kind. Renders on demand, not
// in a loop.

import type { GraphEdge, LayoutResult, Stitch, StitchGraph } from "@crochet-model/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type ColorMode = "yarn" | "type";

export interface ViewOptions {
  colorMode: ColorMode;
  /** Show internal nodes (puffs, loop and chain-space nodes) and the gray edges that place them. */
  showInternal: boolean;
}

export interface HoverInfo {
  stitch: Stitch;
  /** Client coordinates of the pointer. */
  x: number;
  y: number;
}

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

const UP = new THREE.Vector3(0, 1, 0);

export class StructureView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly model = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private framePending = false;

  private graph: StitchGraph | undefined;
  private layout: LayoutResult | undefined;
  private options: ViewOptions = { colorMode: "yarn", showInternal: false };

  private stitchMesh: THREE.InstancedMesh | undefined;
  private shownStitches: Stitch[] = [];
  private baseColors: THREE.Color[] = [];
  private highlighted: number[] = [];

  onHover: ((info: HoverInfo | undefined) => void) | undefined;

  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 2, 3);
    this.camera.add(key); // the light follows the camera
    this.scene.add(this.camera, this.model);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.requestRender());

    new ResizeObserver(() => this.resize()).observe(container);
    this.renderer.domElement.addEventListener("pointermove", (e) => this.pick(e));
    this.renderer.domElement.addEventListener("pointerleave", () => this.setHover(undefined));
    this.resize();
  }

  setModel(graph: StitchGraph, layout: LayoutResult): void {
    this.graph = graph;
    this.layout = layout;
    this.rebuild();
    this.fit();
  }

  setOptions(options: Partial<ViewOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.graph) this.rebuild();
  }

  clear(): void {
    this.setHover(undefined);
    this.graph = undefined;
    this.layout = undefined;
    this.disposeModel();
    this.requestRender();
  }

  /** Frames the whole model. */
  fit(): void {
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // 2D layouts lie in the xy plane: look straight at it. 3D: from slightly above.
    const direction =
      this.layout?.dimension === 2 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0.4, 0.35, 1).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance * 1.05);
    this.camera.near = distance / 100;
    this.camera.far = distance * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.requestRender();
  }

  private rebuild(): void {
    this.setHover(undefined);
    this.disposeModel();
    const graph = this.graph!;
    const positions = this.layout!.positions;
    const at = (id: string) => {
      const p = positions[id];
      return p ? new THREE.Vector3(p[0], p[1], p[2] ?? 0) : undefined;
    };

    const style = getComputedStyle(this.container);
    const cssColor = (name: string, fallback: string) =>
      new THREE.Color(style.getPropertyValue(name).trim() || fallback);

    // Size everything from the typical yarn edge, so any pattern scale reads the same.
    const unit = medianLength(graph.edges.filter((e) => e.kind === "yarn"), at) || 1;

    // Edges
    const edgeGroups: { kind: GraphEdge["kind"]; radius: number; color: THREE.Color }[] = [
      { kind: "yarn", radius: 0.07 * unit, color: cssColor("--yarn", "#3d64b3") },
      { kind: "structure", radius: 0.04 * unit, color: cssColor("--attach", "#c0503c") },
    ];
    if (this.options.showInternal) {
      edgeGroups.push({ kind: "constraint", radius: 0.02 * unit, color: cssColor("--muted", "#888888") });
    }
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    for (const group of edgeGroups) {
      const segments: [THREE.Vector3, THREE.Vector3][] = [];
      for (const e of graph.edges) {
        if (e.kind !== group.kind) continue;
        const a = at(e.tail);
        const b = at(e.head);
        if (a && b && a.distanceToSquared(b) > 1e-12) segments.push([a, b]);
      }
      if (segments.length === 0) continue;
      const mesh = new THREE.InstancedMesh(
        cylinder,
        new THREE.MeshStandardMaterial({ color: group.color, roughness: 0.6 }),
        segments.length,
      );
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const dir = new THREE.Vector3();
      const mid = new THREE.Vector3();
      segments.forEach(([a, b], i) => {
        dir.subVectors(b, a);
        const length = dir.length();
        q.setFromUnitVectors(UP, dir.divideScalar(length));
        mid.addVectors(a, b).multiplyScalar(0.5);
        m.compose(mid, q, new THREE.Vector3(group.radius, length, group.radius));
        mesh.setMatrixAt(i, m);
      });
      this.model.add(mesh);
    }

    // Stitches (top nodes). Hidden tops (start_anew) are left out.
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    this.shownStitches = graph.stitches.filter((s) => s.type !== "hidden" && at(s.id));
    const stitchMesh = new THREE.InstancedMesh(
      sphere,
      new THREE.MeshStandardMaterial({ roughness: 0.45 }),
      Math.max(this.shownStitches.length, 1),
    );
    stitchMesh.count = this.shownStitches.length;
    const m = new THREE.Matrix4();
    const radius = 0.2 * unit;
    this.baseColors = this.shownStitches.map((s, i) => {
      m.makeScale(radius, radius, radius).setPosition(at(s.id)!);
      stitchMesh.setMatrixAt(i, m);
      const color = this.stitchColor(s);
      stitchMesh.setColorAt(i, color);
      return color;
    });
    this.stitchMesh = stitchMesh;
    this.highlighted = [];
    this.model.add(stitchMesh);

    // Internal nodes, small and muted.
    if (this.options.showInternal) {
      const internal = graph.nodes.filter((n) => !n.top).map((n) => at(n.id)).filter((p) => p !== undefined);
      if (internal.length > 0) {
        const mesh = new THREE.InstancedMesh(
          sphere,
          new THREE.MeshStandardMaterial({ color: cssColor("--muted", "#888888"), roughness: 0.6 }),
          internal.length,
        );
        const r = 0.09 * unit;
        internal.forEach((p, i) => mesh.setMatrixAt(i, m.makeScale(r, r, r).setPosition(p)));
        this.model.add(mesh);
      }
    }

    this.requestRender();
  }

  private stitchColor(stitch: Stitch): THREE.Color {
    if (this.options.colorMode === "type") {
      return new THREE.Color(TYPE_COLORS[baseType(stitch.type)] ?? hashColor(baseType(stitch.type)));
    }
    const color = new THREE.Color(0x969696);
    if (stitch.color) {
      try {
        color.setStyle(stitch.color);
      } catch {
        // Not a CSS colour: keep the default grey, as CrochetPARADE does.
      }
    }
    return color;
  }

  private pick(event: PointerEvent): void {
    if (!this.stitchMesh || event.buttons !== 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.stitchMesh, false)[0];
    const stitch = hit?.instanceId !== undefined ? this.shownStitches[hit.instanceId] : undefined;
    this.setHover(stitch && { stitch, x: event.clientX, y: event.clientY });
  }

  /** Highlights the hovered stitch and the stitches it is worked into. */
  private setHover(info: HoverInfo | undefined): void {
    const mesh = this.stitchMesh;
    if (mesh) {
      for (const i of this.highlighted) mesh.setColorAt(i, this.baseColors[i]!);
      this.highlighted = [];
      if (info) {
        const index = new Map(this.shownStitches.map((s, i) => [s.id, i]));
        const self = index.get(info.stitch.id)!;
        mesh.setColorAt(self, new THREE.Color(HOVER_COLOR));
        this.highlighted.push(self);
        for (const id of info.stitch.workedInto) {
          const i = index.get(id);
          if (i === undefined) continue;
          mesh.setColorAt(i, new THREE.Color(BASE_COLOR));
          this.highlighted.push(i);
        }
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.requestRender();
    }
    this.onHover?.(info);
  }

  private disposeModel(): void {
    for (const child of [...this.model.children]) {
      const mesh = child as THREE.InstancedMesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
      this.model.remove(mesh);
    }
    this.stitchMesh = undefined;
    this.shownStitches = [];
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private requestRender(): void {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      this.renderer.render(this.scene, this.camera);
    });
  }
}

/** "scbl" → "sc", "fpdc" → "dc": the palette colours the stitch height. */
function baseType(type: string): string {
  const m = /^(?:fp|bp|r)?(ch|ss|sc|hdc|dc|tr|ring|hidden)(?:bl|fl)?$/.exec(type);
  return m ? m[1]! : type;
}

function hashColor(text: string): THREE.Color {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55);
}

function medianLength(
  edges: GraphEdge[],
  at: (id: string) => THREE.Vector3 | undefined,
): number {
  const lengths: number[] = [];
  for (const e of edges) {
    const a = at(e.tail);
    const b = at(e.head);
    if (a && b) lengths.push(a.distanceTo(b));
  }
  lengths.sort((x, y) => x - y);
  return lengths[Math.floor(lengths.length / 2)] ?? 0;
}
