// CodeMirror 6 with a small CrochetPARADE mode (docs/SPEC.md §9): stitch
// names, counts, `@` attachments, labels, `COLOR:`/`DEF:`/`DOT:` lines and
// comments, with parser errors shown inline.

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder as placeholderExt } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { minimalSetup } from "codemirror";
import { useEffect, useRef } from "react";

const crochetParade = StreamLanguage.define<{ directive: boolean }>({
  name: "crochetparade",
  startState: () => ({ directive: false }),
  token(stream, state) {
    if (stream.sol()) state.directive = false;
    if (stream.eatSpace()) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/^[A-Z][A-Z_]*\s*:/)) {
      state.directive = true;
      return "meta";
    }
    if (state.directive) {
      stream.skipToEnd();
      return "string";
    }
    if (stream.match(/^\$[^$]*\$/)) return "meta";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^\.[A-Za-z_]\w*/)) return "def";
    if (stream.match(/^@\d?/)) return "operator";
    if (stream.match(/^[[\]()]/)) return "bracket";
    if (stream.match(/^[*,<>%!+-]/)) return "operator";
    if (stream.match(/^(turn|sk|ring|ch|ss)\b/)) return "keyword";
    if (stream.match(/^[A-Za-z_]\w*/)) return "variableName";
    stream.next();
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: t.meta, color: "var(--cm-meta)" },
  { tag: t.string, color: "var(--cm-meta)" },
  { tag: t.number, color: "var(--cm-number)" },
  { tag: t.keyword, color: "var(--cm-keyword)" },
  { tag: t.variableName, color: "var(--cm-stitch)", fontWeight: "500" },
  { tag: t.definition(t.variableName), color: "var(--cm-label)" },
  { tag: t.operator, color: "var(--cm-operator)" },
  { tag: t.bracket, color: "var(--cm-operator)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "13px", background: "transparent", color: "var(--ink)" },
  ".cm-content": { fontFamily: "var(--mono)", padding: "6px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 8px" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { background: "transparent", border: "none", color: "var(--faint)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { background: "var(--select) !important" },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--bad)" },
  ".cm-tooltip": { background: "var(--paper)", border: "1px solid var(--line)", borderRadius: "6px" },
});

export interface EditorError {
  /** 1-based line. */
  line: number;
  message: string;
}

interface Props {
  value: string;
  onChange?: (value: string) => void;
  /** Called on blur or Mod-Enter with the final text. */
  onCommit?: (value: string) => void;
  onCancel?: () => void;
  errors?: EditorError[];
  readOnly?: boolean;
  gutter?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  label: string;
}

export function CodeEditor({ value, onChange, onCommit, onCancel, errors = [], readOnly, gutter, autoFocus, placeholder, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onCommit, onCancel });
  handlers.current = { onChange, onCommit, onCancel };

  useEffect(() => {
    const extensions: Extension[] = [
      minimalSetup,
      crochetParade,
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": label }),
      linter(null),
      EditorState.readOnly.of(!!readOnly),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
        if (u.focusChanged && !u.view.hasFocus) handlers.current.onCommit?.(u.state.doc.toString());
      }),
      // Ahead of the default keymap, which takes Mod-Enter for a blank line.
      Prec.highest(
        keymap.of([
          { key: "Mod-Enter", run: (v) => (handlers.current.onCommit?.(v.state.doc.toString()), true) },
          { key: "Escape", run: () => (handlers.current.onCancel?.(), !!handlers.current.onCancel) },
        ]),
      ),
    ];
    if (gutter) extensions.push(lineNumbers(), lintGutter());
    if (placeholder) extensions.push(placeholderExt(placeholder));
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions }) });
    view.current = v;
    if (autoFocus) {
      v.focus();
      v.dispatch({ selection: { anchor: v.state.doc.length } });
    }
    return () => v.destroy();
    // The editor is built once; value and errors are pushed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, gutter]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const diagnostics: Diagnostic[] = errors
      .filter((e) => e.line >= 1 && e.line <= v.state.doc.lines)
      .map((e) => {
        const line = v.state.doc.line(e.line);
        return { from: line.from, to: Math.max(line.to, line.from), severity: "error", message: e.message };
      });
    v.dispatch(setDiagnostics(v.state, diagnostics));
  }, [errors]);

  return <div className="code-editor" ref={host} />;
}
