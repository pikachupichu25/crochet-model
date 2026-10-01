# CrochetPARADE reference

CrochetPARADE describes crochet as text that a parser turns into a stitch graph: which stitch is worked into which. This reference covers the part of the language needed to translate written patterns. Every example in it parses.

## Rows and the default flow

- Each line is one row or round. Items on a line are separated by commas: `sk,6sc,turn`.
- By default each stitch is worked into the next unused stitch of the previous line, in order. Only override this when the English says to work somewhere else.
- `turn` reverses direction: the next line starts at the last stitch of this line and works back. `turn` must be the last item on its line.
- Without `turn` (rounds), the next line starts at the first stitch of this line and works forward. Spiral rounds with no join are simply consecutive lines.
- A line with a counter initialiser such as `$k=0$` on its own also works; it makes no stitches.
- `#` starts a comment, to the end of the line.

## Stitches

- Basic: `ch`, `ss` (slip stitch), `sc`, `hdc`, `dc`, `tr`, `dtr`, `trtr`. There is no `slst` or `sl`; write `ss`. There is no `tc`; treble is `tr`.
- Back and front loop only: add `bl` or `fl`: `scbl`, `hdcfl`, `dcbl`.
- Post stitches: prefix `fp` or `bp`: `fpdc`, `bpdc`, `fpsc`, `bphdc`, `fptr`.
- Increase: `sc2inc` is 2 sc in one stitch; `dc3inc` is 3 dc in one stitch. Any stitch name works: `hdc2inc`, `sc6inc`.
- Decrease: `sc2tog` is one sc worked over 2 stitches; `dc3tog` over 3. An invisible decrease is written `sc2tog`.
- Clusters: `hdc3puff`, `dc3bobble`, `dc4bobble`, `dc3pc` (popcorn), `picot3` (3 ch and a slip stitch back into the first).
- `sk` skips one stitch of the previous line; `2sk` skips two.
- `ring` is a magic ring. It is a stitch of its own on its own line.
- The full list of built-in stitch names is given below. Other names are errors unless the pattern defines them.

## Counts, groups and repeats

- `6sc` or `6*sc` is 6 single crochet, each in its own stitch.
- A group in square brackets repeats: `6*[sc,sc2inc]` or `[sc,sc2inc]*6`.
- `>` inside a group ends the last repeat early: `[2sc,>,dc]*3` is `2sc,dc,2sc,dc,2sc`. `<` starts the first repeat part way.
- Parentheses group without repeating; a label or attachment after the group applies to every stitch in it: `(sc,2ch,sc)@[@]`.

## Working into a particular place

The default flow covers "in the next stitch" and "in each stitch across". For anything else, attach with `@`:

- `@[@]` is the stitch the previous stitch was worked into: "2 dc in the same stitch" after a dc is `dc,dc@[@]`. Chains are not worked into anything, so `sc,2ch,sc@[@]` puts both sc in one stitch.
- `@[row,i]` is stitch `i` of line `row`, both counted from 0, over every line that has stitches (the `ring` line counts). Stitches are numbered in the order they were made, so after a `turn` the next line meets them from the highest number down. Negative numbers count from the end: `@[-1,0]` is the first stitch made in the previous line, `@[-1,-1]` the last. `%` means the current line: `ss@[%,0]` slips into the first stitch of this line.
- `[%,i]` counts every stitch of the current line, chains included. If the round starts with `ch`, its first sc is `[%,1]`; if it starts with `3ch`, the top of that chain is `[%,2]`.
- After `@` moves the flow, later stitches continue from there: `3sc,dc@[-1,5],dc` works the second dc into stitch 6 of the previous line.

## Labels: chain spaces and marked stitches

- `.A` after a stitch or group labels it: `3ch.A` labels a chain-3. Later, `@A` works into it: `5dc@A` puts 5 dc into that chain space.
- Several spaces in one line need distinct labels. Use an index: `3ch.A[0]`, `3ch.A[1]`, then `@A[0]`, `@A[1]`. A counter can make the indices: `$k=0$,[3ch.A[k++],2sk,sc]*4` labels `A[0]`…`A[3]`. Initialise a counter with `$k=0$` before its first use.
- **Order after turning.** After `turn`, the next line meets the spaces of the previous line in reverse order of creation: the last space made is the first one reached. Write the indices in the order the stitches are worked, for example `ch,sc,2sc@A[3],sc,2sc@A[2],sc,2sc@A[1],sc,2sc@A[0],sc`. In rounds (no `turn`) spaces come in the order they were made.
- A label must be defined on an earlier stitch than the one that uses it. If the English works into a space made in an earlier row that you did not label, ask for that row to be amended (see the output rules).
- Label names are letters, digits and `_`, starting with a letter. Do not reuse a stitch name as a label or counter name.

## Rounds

- Magic ring: `ring.R` on its own line, then the first round works into it: "6 sc in a magic ring" is `ring.R` then `6sc@R`.
- Chain ring: "ch 4, join with sl st to form a ring" is `4ch.R,ss@[%,0]`; then "12 dc in the ring" is `12dc@R`.
- Joining a round: "sl st to first sc" is `ss@[%,i]` where `i` is the first sc's position on this line (0, or 1 after a leading `ch`). "sl st to top of beginning ch-3" is `ss@[%,2]`.
- After a joined round, the next round starts again at the first stitch of the previous round.

## Rows

- Foundation chain: "Ch 16" is `16ch`. If the next row works back along the chain, end the line with `turn`.
- "sc in 2nd ch from hook" skips the chain nearest the hook: `sk,sc`. "dc in 4th ch from hook" is `3sk,dc`.
- Turning chain: in CrochetPARADE `turn` ends a line, so a turning chain that the English writes at the end of a row ("…, ch 1, turn") is written at the start of the next line: this line ends with `turn`, the next begins `ch,…`.
- "Ch 3 (counts as first dc)" at the start of a row: `3ch,sk,…` — the chain stands in for the first stitch, so the first stitch of the previous row is skipped. Record this as an assumption.
- "dc in top of turning chain" at the end of a row: the chain made at the start of the previous line, for example `dc@[-1,2]` when that line began with `3ch`.
- "Rows 4–7: sc across" stands for 4 rows: write 4 lines.

## Colour and pieces

- `COLOR: navy` on its own line sets the colour of the stitches that follow. Use the colour names the user gave; if none are known, use a plain X11 colour name and record the choice as an assumption.
- `start_anew` on its own line starts a new piece, not attached to the work so far.
- Finishing ("fasten off", "weave in ends", "stuff") makes no stitches: return an empty translation for such a row.

## How the parser counts stitches

A line's count is every stitch it makes, chains included; `ss`, `ring` and `start_anew` do not count. `sc2inc` counts 2, `sc2tog` counts 1, `picot3` counts 3. So `ch,6sc2inc,ss@[%,1]` counts 13, and `3ch,sk,5dc` counts 8. Patterns usually leave turning chains out of their counts; that is expected.

## Parser errors and their usual causes

- `Label not found`: a label is used but never defined earlier, or its index is off (spaces taken in the wrong order after a turn).
- `Stitch type not defined`: a stitch name that is not built in (`slst`, `tc`, `dcfp`, `inc`, `dec`).
- `ID not found` / `Stitch at that position not found`: an `@[row,i]` outside the rows or stitches that exist.
- No error, but a wrong count: working more stitches than the previous line has is not an error to the parser. The stated count is the check.
- `Cannot attach into the future`: attaching to a stitch that comes later than the current one.
- `Turning can happen only at the end of a row`: something follows `turn` on the line.
