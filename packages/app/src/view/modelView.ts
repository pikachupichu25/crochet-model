// The model view: a laid-out stitch graph drawn by one level of detail at a
// time, structure (docs/SPEC.md §6.5) or symbols (docs/symbol/SPEC.md §5).
// The camera, controls, picking and highlights live here, so switching mode
// keeps the camera and does not lay out again. Renders on demand, not in a
// loop.

import type { LayoutResult, LegendEntry, Stitch, StitchGraph } from "@crochet-model/core";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Layer, RowAnchor, ViewOptions } from "./layer.ts";
import { StructureLayer } from "./structureLayer.ts";
import { SymbolLayer } from "./symbolLayer.ts";

export type { ColorMode, ViewMode, ViewOptions } from "./layer.ts";
export { BASE_COLOR, HOVER_COLOR, SELECT_COLOR } from "./palette.ts";

export interface HoverInfo {
  stitch: Stitch;
  /** Client coordinates of the pointer. */
  x: number;
  y: number;
}

export class ModelView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly model = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private framePending = false;
  private disposed = false;

  private graph: StitchGraph | undefined;
  private layout: LayoutResult | undefined;
  private options: ViewOptions = { mode: "structure", colorMode: "yarn", showInternal: false, surface: true, yarnPath: false, rowNumbers: false };
  private layer: Layer | undefined;
  private hovered: HoverInfo | undefined;
  private selected = new Set<string>();
  private highlightKey: string | undefined;
  /** Row numbers over the canvas, placed after each render. */
  private readonly labelLayer = document.createElement("div");
  private labels: { anchor: RowAnchor; el: HTMLElement }[] = [];
  private rowLabel: (row: number) => string = (row) => String(row + 1);

  onHover: ((info: HoverInfo | undefined) => void) | undefined;
  /** A click on a stitch, or on empty space (undefined). Drags that orbit are not clicks. */
  onPick: ((stitch: Stitch | undefined) => void) | undefined;
  /** The symbol legend after each build in symbol mode; undefined in structure mode. */
  onLegend: ((entries: LegendEntry[] | undefined) => void) | undefined;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;

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
    // A layer that fades by facing repaints as the camera moves.
    this.controls.addEventListener("change", () => (this.layer?.followsCamera ? this.paint() : this.requestRender()));
    this.labelLayer.className = "row-labels";
    container.append(this.labelLayer);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.renderer.domElement.addEventListener("pointermove", (e) => this.pick(e));
    this.renderer.domElement.addEventListener("pointerleave", () => this.setHover(undefined));
    let down: { x: number; y: number } | undefined;
    this.renderer.domElement.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      down = undefined;
      this.onPick?.(this.stitchAt(e));
    });
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

  /** Highlights these stitches until the selection changes. */
  setSelection(ids: Iterable<string>): void {
    this.selected = new Set(ids);
    this.paint();
  }

  /** Highlights every symbol of a legend entry (symbol mode); undefined clears it. */
  setHighlightKey(key: string | undefined): void {
    this.highlightKey = key;
    this.paint();
  }

  /** The text of each row number: the English label when the app knows it. */
  setRowLabel(text: (row: number) => string): void {
    this.rowLabel = text;
    for (const { anchor, el } of this.labels) el.textContent = text(anchor.row);
  }

  /** The current 2D symbol view as an SVG chart; undefined in structure mode or 3D (SYM-FR-6.1). */
  exportSvg(title?: string): string | undefined {
    if (!(this.layer instanceof SymbolLayer)) return undefined;
    const style = getComputedStyle(this.container);
    const css = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return this.layer.svg({
      ink: css("--ink", "#2a2420"),
      background: css("--card", "#fbf8f1"),
      rowLabel: this.options.rowNumbers ? this.rowLabel : undefined,
      title,
    });
  }

  /** A PNG of the view as it is, row numbers included, on the viewport's background (FR-6.3, SYM-FR-6.2). */
  snapshot(): Promise<Blob> {
    const canvas = this.renderer.domElement;
    // Read the canvas in the same task as a render, before the buffer is cleared.
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d")!;
    const style = getComputedStyle(this.container);
    ctx.fillStyle = style.getPropertyValue("--card").trim() || "#fbf8f1";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    const scale = out.width / Math.max(this.container.clientWidth, 1);
    ctx.font = `600 ${11 * scale}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = style.getPropertyValue("--muted").trim() || "#6e655b";
    this.placeLabels();
    const p = new THREE.Vector3();
    for (const { anchor, el } of this.labels) {
      if (el.hidden) continue;
      p.copy(anchor.at).project(this.camera);
      ctx.fillText(el.textContent ?? "", ((p.x + 1) / 2) * out.width, ((1 - p.y) / 2) * out.height);
    }
    return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not make a PNG."))), "image/png"));
  }

  /** Frames the selected stitches, or the whole model when none are shown. */
  focusSelection(): void {
    if (!this.layout) return;
    const at = [...this.selected].map((id) => this.layout!.positions[id]).filter((p) => p !== undefined);
    if (at.length === 0) return;
    const box = new THREE.Box3().setFromPoints(at.map((p) => new THREE.Vector3(p[0], p[1], p[2] ?? 0)));
    const target = box.getCenter(new THREE.Vector3());
    // Keep the distance; turn to look at the row.
    this.camera.position.add(target.clone().sub(this.controls.target));
    this.controls.target.copy(target);
    this.controls.update();
    this.requestRender();
  }

  /** Frees the GPU resources and removes the canvas. */
  dispose(): void {
    this.disposed = true;
    this.clear();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }

  clear(): void {
    this.hovered = undefined;
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
    this.hovered = undefined;
    this.disposeModel();
    const style = getComputedStyle(this.container);
    const symbols = this.options.mode === "symbols";
    const layer: Layer = symbols ? new SymbolLayer() : new StructureLayer();
    if (layer instanceof SymbolLayer) layer.onLegend = (entries) => this.onLegend?.(entries);
    else this.onLegend?.(undefined);
    layer.build({
      group: this.model,
      graph: this.graph!,
      layout: this.layout!,
      options: this.options,
      cssColor: (name, fallback) => new THREE.Color(style.getPropertyValue(name).trim() || fallback),
    });
    this.layer = layer;
    const { clientWidth: w, clientHeight: h } = this.container;
    layer.resize?.(w, h);
    if (this.options.rowNumbers && layer.rowAnchors) {
      this.labels = layer.rowAnchors().map((anchor) => {
        const el = document.createElement("span");
        el.textContent = this.rowLabel(anchor.row);
        this.labelLayer.append(el);
        return { anchor, el };
      });
    }
    this.paint();
  }

  /** Puts each row number over its anchor; hides those behind the camera or facing away. */
  private placeLabels(): void {
    if (!this.labels.length) return;
    const { clientWidth: w, clientHeight: h } = this.container;
    const p = new THREE.Vector3();
    const toEye = new THREE.Vector3();
    for (const { anchor, el } of this.labels) {
      p.copy(anchor.at).project(this.camera);
      const facing = anchor.out.dot(toEye.subVectors(this.camera.position, anchor.at)) > 0;
      const shown = facing && p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
      el.hidden = !shown;
      if (shown) el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  }

  private stitchAt(event: PointerEvent): Stitch | undefined {
    if (!this.layer) return undefined;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    return this.layer.stitchAt(this.raycaster);
  }

  private pick(event: PointerEvent): void {
    if (!this.layer || event.buttons !== 0) return;
    const stitch = this.stitchAt(event);
    this.setHover(stitch && { stitch, x: event.clientX, y: event.clientY });
  }

  /** Highlights the hovered stitch and the stitches it is worked into. */
  private setHover(info: HoverInfo | undefined): void {
    this.hovered = info;
    this.paint();
    this.onHover?.(info);
  }

  private paint(): void {
    const hover = this.hovered?.stitch;
    this.layer?.paint({
      hover,
      bases: new Set(hover?.workedInto ?? []),
      selected: this.selected,
      highlightKey: this.highlightKey,
      eye: this.camera.position,
    });
    this.requestRender();
  }

  private disposeModel(): void {
    for (const child of [...this.model.children]) {
      const mesh = child as THREE.Mesh & { dispose?: () => void };
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose?.();
      this.model.remove(mesh);
    }
    this.layer = undefined;
    this.labelLayer.replaceChildren();
    this.labels = [];
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.layer?.resize?.(w, h);
    this.requestRender();
  }

  private requestRender(): void {
    if (this.framePending || this.disposed) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      if (this.disposed) return;
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    });
  }
}
