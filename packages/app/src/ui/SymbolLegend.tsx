// The symbol legend (SYM-FR-5.x): each symbol in the model with its US name,
// abbreviation and count. Icons come from the same glyph code as the view.
// Hovering an entry highlights its stitches.

import { legendIcon, type LegendEntry } from "@crochet-model/core";
import { useEffect, useMemo, useRef } from "react";

export function SymbolLegend({ entries, onHighlight }: { entries: LegendEntry[]; onHighlight: (key: string | undefined) => void }) {
  // Leaving symbol mode unmounts the legend with no mouseleave: clear the highlight.
  // The parent passes a new function each render, so the cleanup reads the latest.
  const highlight = useRef(onHighlight);
  highlight.current = onHighlight;
  useEffect(() => () => highlight.current(undefined), []);
  const known = entries.filter((e) => !e.fallback);
  const unknown = entries.filter((e) => e.fallback);
  return (
    <div className="symbol-legend" aria-label="Symbol legend">
      <ul>
        {known.map((e) => (
          <Entry key={e.key} entry={e} onHighlight={onHighlight} />
        ))}
      </ul>
      {unknown.length > 0 && (
        <>
          <span className="symbol-legend-head">No symbol</span>
          <ul>
            {unknown.map((e) => (
              <Entry key={e.key} entry={e} onHighlight={onHighlight} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Entry({ entry, onHighlight }: { entry: LegendEntry; onHighlight: (key: string | undefined) => void }) {
  return (
    <li onMouseEnter={() => onHighlight(entry.key)} onMouseLeave={() => onHighlight(undefined)}>
      <Icon symbolKey={entry.key} />
      <span>
        {entry.name} <code>{entry.key}</code>
      </span>
      <span className="count">{entry.count}</span>
    </li>
  );
}

const PAD = 0.2;

function Icon({ symbolKey }: { symbolKey: string }) {
  const icon = useMemo(() => legendIcon(symbolKey), [symbolKey]);
  const [x0, y0, x1, y1] = icon.box;
  // Square box, so every icon is drawn at the same scale per unit height.
  const h = Math.max(y1 - y0, x1 - x0, 1) + 2 * PAD;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return (
    <svg className="symbol-icon" viewBox={`${cx - h / 2} ${-cy - h / 2} ${h} ${h}`} aria-hidden="true">
      {/* Layout y points up, SVG y down. */}
      <g transform="scale(1,-1)" fill="none" stroke="currentColor" strokeWidth={0.09} strokeLinecap="round" strokeLinejoin="round">
        {icon.lines.map((line, i) => (
          <polyline key={i} points={line.map(([x, y]) => `${x},${y}`).join(" ")} />
        ))}
        {icon.dots.map((d, i) => (
          <circle key={`d${i}`} cx={d.at[0]} cy={d.at[1]} r={d.radius} fill="currentColor" stroke="none" />
        ))}
      </g>
    </svg>
  );
}
