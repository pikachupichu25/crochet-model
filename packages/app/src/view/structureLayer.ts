// Structure mode (docs/SPEC.md §6.5): a ball-and-stick view of a laid-out
// stitch graph. Stitches are spheres, edges are cylinders; both are instanced,
// so a few thousand stitches cost two draw calls per kind.

import type { GraphEdge, Stitch } from "@crochet-model/core";
import * as THREE from "three";
import type { BuildContext, Layer, PaintState } from "./layer.ts";
import { BASE_COLOR, HOVER_COLOR, SELECT_COLOR, typeColor, yarnColor } from "./palette.ts";

const UP = new THREE.Vector3(0, 1, 0);

export class StructureLayer implements Layer {
  private stitchMesh: THREE.InstancedMesh | undefined;
  private shown: Stitch[] = [];
  private baseColors: THREE.Color[] = [];

  build({ group, graph, layout, options, cssColor }: BuildContext): void {
    const positions = layout.positions;
    const at = (id: string) => {
      const p = positions[id];
      return p ? new THREE.Vector3(p[0], p[1], p[2] ?? 0) : undefined;
    };

    // A magic ring is one node that round 1 hangs off; drawn, it reads as a
    // stray stitch. CrochetPARADE draws it too small to see. Leave it and its
    // edges out.
    const rings = new Set(graph.stitches.filter((s) => s.type === "ring").map((s) => s.id));

    // Size everything from the typical yarn edge, so any pattern scale reads the same.
    const unit = medianLength(graph.edges.filter((e) => e.kind === "yarn"), at) || 1;

    // Edges
    const edgeGroups: { kind: GraphEdge["kind"]; radius: number; color: THREE.Color }[] = [
      { kind: "yarn", radius: 0.07 * unit, color: cssColor("--yarn", "#3d64b3") },
      { kind: "structure", radius: 0.04 * unit, color: cssColor("--attach", "#c0503c") },
    ];
    if (options.showInternal) {
      edgeGroups.push({ kind: "constraint", radius: 0.02 * unit, color: cssColor("--muted", "#888888") });
    }
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    for (const edges of edgeGroups) {
      const segments: [THREE.Vector3, THREE.Vector3][] = [];
      for (const e of graph.edges) {
        if (e.kind !== edges.kind || rings.has(e.tail) || rings.has(e.head)) continue;
        const a = at(e.tail);
        const b = at(e.head);
        if (a && b && a.distanceToSquared(b) > 1e-12) segments.push([a, b]);
      }
      if (segments.length === 0) continue;
      const mesh = new THREE.InstancedMesh(
        cylinder,
        new THREE.MeshStandardMaterial({ color: edges.color, roughness: 0.6 }),
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
        m.compose(mid, q, new THREE.Vector3(edges.radius, length, edges.radius));
        mesh.setMatrixAt(i, m);
      });
      group.add(mesh);
    }

    // Stitches (top nodes). Hidden tops (start_anew) and rings are left out.
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    this.shown = graph.stitches.filter((s) => s.type !== "hidden" && !rings.has(s.id) && at(s.id));
    const stitchMesh = new THREE.InstancedMesh(
      sphere,
      new THREE.MeshStandardMaterial({ roughness: 0.45 }),
      Math.max(this.shown.length, 1),
    );
    stitchMesh.count = this.shown.length;
    const m = new THREE.Matrix4();
    const radius = 0.2 * unit;
    this.baseColors = this.shown.map((s, i) => {
      m.makeScale(radius, radius, radius).setPosition(at(s.id)!);
      stitchMesh.setMatrixAt(i, m);
      const color = options.colorMode === "type" ? typeColor(s.type) : yarnColor(s.color);
      stitchMesh.setColorAt(i, color);
      return color;
    });
    this.stitchMesh = stitchMesh;
    group.add(stitchMesh);

    // Internal nodes, small and muted.
    if (options.showInternal) {
      const internal = graph.nodes.filter((n) => !n.top).map((n) => at(n.id)).filter((p) => p !== undefined);
      if (internal.length > 0) {
        const mesh = new THREE.InstancedMesh(
          sphere,
          new THREE.MeshStandardMaterial({ color: cssColor("--muted", "#888888"), roughness: 0.6 }),
          internal.length,
        );
        const r = 0.09 * unit;
        internal.forEach((p, i) => mesh.setMatrixAt(i, m.makeScale(r, r, r).setPosition(p)));
        group.add(mesh);
      }
    }
  }

  stitchAt(raycaster: THREE.Raycaster): Stitch | undefined {
    if (!this.stitchMesh) return undefined;
    const hit = raycaster.intersectObject(this.stitchMesh, false)[0];
    return hit?.instanceId !== undefined ? this.shown[hit.instanceId] : undefined;
  }

  /** Colours every stitch: hovered, its base, selected, or its own colour. */
  paint({ hover, bases, selected }: PaintState): void {
    const mesh = this.stitchMesh;
    if (!mesh) return;
    const hoverColor = new THREE.Color(HOVER_COLOR);
    const baseColor = new THREE.Color(BASE_COLOR);
    const selectColor = new THREE.Color(SELECT_COLOR);
    this.shown.forEach((s, i) => {
      const color =
        s.id === hover?.id ? hoverColor : bases.has(s.id) ? baseColor : selected.has(s.id) ? selectColor : this.baseColors[i]!;
      mesh.setColorAt(i, color);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

function medianLength(edges: GraphEdge[], at: (id: string) => THREE.Vector3 | undefined): number {
  const lengths: number[] = [];
  for (const e of edges) {
    const a = at(e.tail);
    const b = at(e.head);
    if (a && b) lengths.push(a.distanceTo(b));
  }
  lengths.sort((x, y) => x - y);
  return lengths[Math.floor(lengths.length / 2)] ?? 0;
}
