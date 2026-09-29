// Typed stitch graph from the parser's graphJson (SPEC.md §3.3).
//
// Format, from export_to_dot in parse64.js (vendored commit 06e987b):
//
// - Every stitch statement has a uid (its statement number; `sk` uses one
//   and makes no node). A statement has zero or more top nodes, named
//   `row,index|uid`: a sc2inc has two, a picot3 four (ch, ch, ch, ss). A top
//   node's label is `type|context|colour`; context is HTML and can be long.
// - Internal ("other") nodes of a statement are named `row,index<X>|uid`,
//   where row,index is the statement's first top node and X is the node's
//   letter from the stitch definition, sometimes with a digit (`2,6C|6`,
//   `3,0C0|138`). Puffs, bobbles, popcorns and chain-space attachments use
//   them. Their type is usually `hidden`; custom DEF: stitches can use others
//   (`line`, `dc`).
// - A back- or front-loop, or post, attachment inserts a hidden node named
//   `<target>a<head>_jacobian<j>` between the stitch worked into and the
//   node it attaches to. j > 0 is the back, j < 0 the front.
// - An attachment into a space along a post can insert a hidden node named
//   `$<p0>--<p1>:<d0>:<d1>|<uids>`. It can be emitted more than once, so
//   nodes are deduplicated by name.
// - Edge colours: blue is the yarn running from stitch to stitch (at most one
//   blue edge enters a node), red is structure (worked into, or inside a
//   stitch), gray is a constraint that places a hidden node, e.g. inside a
//   chain space between two stitches. Each edge has a rest length `len`.
//
// simpleDot has the same nodes and edges, without labels or colours.

/** A top node: one crochet stitch as CrochetPARADE counts them. */
export interface Stitch {
  /** The node name, e.g. "3,12|40". Unique. */
  id: string;
  /** 0-based, as CrochetPARADE counts rows. */
  row: number;
  /** Position within its row. */
  index: number;
  /** Statement uid. A sc2inc or picot3 gives several stitches one statement. */
  statement: number;
  /** "sc", "dc", "ch", "ss", "ring", "hidden", or a DEF: name. For a dc2tog, "dc". */
  type: string;
  /** Ids of the stitches it attaches to, in the order the graph lists them. */
  workedInto: string[];
  /** True when it attaches into a space (chain space, post) rather than a stitch's top. */
  intoSpace: boolean;
  /** Set for back/front-loop and post stitches. */
  side?: "back" | "front";
  /** Its nodes in the full graph: this top node, then the statement's internal nodes. */
  nodeIds: string[];
  /** Labels defined on it (`sc.A`), as the parser reports them. */
  labels: string[];
  color?: string;
}

export type EdgeKind =
  /** Blue: the yarn from one stitch to the next. */
  | "yarn"
  /** Red: an attachment, or a spring inside a stitch. */
  | "structure"
  /** Gray: places a hidden node, e.g. in a chain space. */
  | "constraint";

export interface GraphEdge {
  tail: string;
  head: string;
  /** Rest length, in stitch units. */
  len: number;
  kind: EdgeKind;
  color?: string;
}

export interface GraphNode {
  id: string;
  /** "sc", "hidden", "line", … */
  type: string;
  /** True for top nodes, which are the stitches. */
  top: boolean;
  /** Owning statement, when the name says so. Jacobian and `$` nodes have none. */
  statement?: number;
  /** Not drawn by CrochetPARADE (`style: invis`). */
  hidden: boolean;
}

export interface StitchGraph {
  /** Top nodes, in working order. */
  stitches: Stitch[];
  edges: GraphEdge[];
  /** Every node, top and internal, in the order the parser emits them. */
  nodes: GraphNode[];
}

interface RawElement {
  type: string;
  name?: string;
  label?: string;
  attachmentLabel?: unknown;
  style?: string;
  tail?: string;
  head?: string;
  color?: string;
  len?: string;
}

const TOP_NODE = /^(\d+),(\d+)\|(\d+)$/;
const OWNED_NODE = /^\d+,\d+[A-Za-z][A-Za-z0-9]*\|(\d+)$/;
const JACOBIAN = /_jacobian(-?[\d.]+)$/;

const EDGE_KIND: Record<string, EdgeKind> = {
  blue: "yarn",
  red: "structure",
  gray: "constraint",
};

export function parseStitchGraph(graphJson: string): StitchGraph {
  const { elements } = JSON.parse(graphJson) as { elements: RawElement[] };
  const nodes: GraphNode[] = [];
  const byId = new Map<string, GraphNode>();
  const stitches: Stitch[] = [];
  const stitchById = new Map<string, Stitch>();
  const edges: GraphEdge[] = [];

  for (const el of elements) {
    if (el.type === "node" && el.name !== undefined) {
      if (byId.has(el.name)) continue;
      const label = el.label ?? "";
      const type = label.split("|", 1)[0]!;
      const top = TOP_NODE.exec(el.name);
      const owned = top ? undefined : OWNED_NODE.exec(el.name);
      const node: GraphNode = {
        id: el.name,
        type,
        top: !!top,
        statement: top ? Number(top[3]) : owned ? Number(owned[1]) : undefined,
        hidden: el.style === "invis" || type === "hidden",
      };
      nodes.push(node);
      byId.set(node.id, node);
      if (top) {
        const bar = label.lastIndexOf("|");
        const stitch: Stitch = {
          id: el.name,
          row: Number(top[1]),
          index: Number(top[2]),
          statement: Number(top[3]),
          type,
          workedInto: [],
          intoSpace: false,
          nodeIds: [el.name],
          labels: Array.isArray(el.attachmentLabel) ? el.attachmentLabel.map(String) : [],
          color: bar > 0 ? label.slice(bar + 1) : undefined,
        };
        stitches.push(stitch);
        stitchById.set(stitch.id, stitch);
      }
    } else if (el.type === "edge" && el.tail !== undefined && el.head !== undefined) {
      edges.push({
        tail: el.tail,
        head: el.head,
        len: Number(el.len),
        kind: EDGE_KIND[el.color ?? ""] ?? "structure",
        color: el.label,
      });
    }
  }

  // Internal nodes belong to every top node of their statement.
  const topsByStatement = new Map<number, Stitch[]>();
  for (const s of stitches) {
    const list = topsByStatement.get(s.statement);
    if (list) list.push(s);
    else topsByStatement.set(s.statement, [s]);
  }
  for (const n of nodes) {
    if (n.top || n.statement === undefined) continue;
    for (const s of topsByStatement.get(n.statement) ?? []) s.nodeIds.push(n.id);
  }

  // Non-yarn edges into each node, for the backward walk.
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (e.kind === "yarn") continue;
    const list = incoming.get(e.head);
    if (list) list.push(e);
    else incoming.set(e.head, [e]);
  }

  for (const s of stitches) resolveAttachments(s, byId, stitchById, incoming);

  return { stitches, edges, nodes };
}

/**
 * Walks backwards from a stitch's top node over structure and constraint
 * edges, through its own internal nodes, jacobian and `$` nodes, and the
 * other top nodes of its statement, until it reaches other stitches.
 *
 * At an internal node that is fed by other internal nodes, only those are
 * followed. This skips springs that close a stitch's shape: a popcorn ties
 * the previous stitch to one of its internal nodes (`!-0.33-D`), which is
 * not what it is worked into.
 */
function resolveAttachments(
  stitch: Stitch,
  nodes: Map<string, GraphNode>,
  stitches: Map<string, Stitch>,
  incoming: Map<string, GraphEdge[]>,
) {
  const into = new Set<string>();
  const visited = new Set<string>([stitch.id]);
  const isInside = (id: string) => {
    const n = nodes.get(id);
    if (!n) return false;
    if (!n.top) return n.statement === undefined || n.statement === stitch.statement;
    return n.statement === stitch.statement;
  };

  const walk = (id: string, viaConstraint: boolean) => {
    let preds = incoming.get(id) ?? [];
    const node = nodes.get(id);
    if (node && !node.top) {
      const internal = preds.filter((e) => isInside(e.tail));
      if (internal.length > 0) preds = internal;
    }
    for (const e of preds) {
      const j = JACOBIAN.exec(e.tail) ?? JACOBIAN.exec(id);
      if (j && stitch.side === undefined) stitch.side = Number(j[1]) > 0 ? "back" : "front";
      const constraint = viaConstraint || e.kind === "constraint";
      if (isInside(e.tail)) {
        if (visited.has(e.tail)) continue;
        visited.add(e.tail);
        walk(e.tail, constraint);
      } else if (stitches.has(e.tail)) {
        into.add(e.tail);
        if (constraint) stitch.intoSpace = true;
      }
    }
  };
  walk(stitch.id, false);
  stitch.workedInto = [...into];
}
