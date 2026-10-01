# Worked examples

Each example is a short pattern written for this reference. The CrochetPARADE puts a `#` comment with the row label before each row's lines.

## Flat rows with a turning chain and decreases

```text
Row 1: Ch 11.
Row 2: Sc in 2nd ch from hook and in each ch across, ch 1, turn. (10)
Row 3: Sc in each st across, ch 1, turn. (10)
Row 4: Sc2tog, sc in each st to last 2 sts, sc2tog. (8)
```

```cp
# Row 1
11ch,turn
# Row 2
sk,10sc,turn
# Row 3
ch,10sc,turn
# Row 4
ch,sc2tog,6sc,sc2tog
```

The foundation chain ends with `turn` because Row 2 works back along it. "2nd ch from hook" skips the nearest chain. Each "ch 1, turn" ends its line with `turn` and puts the `ch` at the start of the next line; the pattern does not count it.

## A beginning chain that counts as a stitch

```text
Row 1: Ch 11.
Row 2: Sc in 2nd ch from hook and in each ch across, turn. (10)
Row 3: Ch 3 (counts as dc), dc in each st across, turn. (10)
Row 4: Ch 3 (counts as dc), dc in each st across, ending with dc in top of turning ch. (10)
```

```cp
# Row 1
11ch,turn
# Row 2
sk,10sc,turn
# Row 3
3ch,sk,9dc,turn
# Row 4
3ch,sk,8dc,dc@[-1,2]
```

The chain-3 stands in for the first dc, so the stitch under it is skipped and 9 dc follow. In Row 4 the last dc goes into the top of Row 3's chain-3, which is stitch 2 of that line.

## Amigurumi rounds from a magic ring

```text
Rnd 1: 6 sc in magic ring. (6)
Rnd 2: Inc in each st around. (12)
Rnd 3: (Sc, inc) 6 times. (18)
Rnd 4: Sc in each st around. (18)
Rnd 5: (Sc, dec) 6 times. (12)
Rnd 6: Fasten off, leaving a long tail.
```

```cp
# Rnd 1
ring.R
6sc@R
# Rnd 2
6*sc2inc
# Rnd 3
6*[sc,sc2inc]
# Rnd 4
18sc
# Rnd 5
6*[sc,sc2tog]
# Rnd 6
```

The ring is its own line and Rnd 1 works into it. Spiral rounds need no joins. Finishing makes no stitches, so its translation is empty.

## Joined rounds

```text
Rnd 1: Ch 1, 6 sc in magic ring, sl st to first sc to join. (6)
Rnd 2: Ch 1, 2 sc in each st around, sl st to first sc to join. (12)
Rnd 3: Ch 1, *sc in next st, 2 sc in next st; rep from * around, sl st to first sc to join. (18)
```

```cp
# Rnd 1
ring.R
ch,6sc@R,ss@[%,1]
# Rnd 2
ch,6*sc2inc,ss@[%,1]
# Rnd 3
ch,6*[sc,sc2inc],ss@[%,1]
```

Each round starts with `ch`, so its first sc is stitch 1 of the line. The slip stitch does not count, and neither does the chain.

## A chain ring

```text
Ch 4, join with sl st to form a ring.
Rnd 1: Ch 3 (counts as dc), 11 dc in ring, join with sl st to top of ch-3. (12)
```

```cp
# Ch 4, join
4ch.R,ss@[%,0]
# Rnd 1
3ch,11dc@R,ss@[%,2]
```

The ring of chains is labelled when it is made so the next round can work into it. The join goes into the top of the chain-3, stitch 2 of the line.

## Chain spaces worked after a turn

```text
Row 1: Ch 10.
Row 2: Sc in 2nd ch from hook, *ch 2, skip next ch, sc in next ch; rep from * 3 more times, turn.
Row 3: Ch 1, sc in first sc, *2 sc in next ch-2 sp, sc in next sc; rep from * across. (13)
```

```cp
# Row 1
10ch,turn
# Row 2
$k=0$,sk,sc,[2ch.A[k++],sk,sc]*4,turn
# Row 3
ch,sc,2sc@A[3],sc,2sc@A[2],sc,2sc@A[1],sc,2sc@A[0],sc
```

Row 2 labels each chain space as it is made, because Row 3 works into them. After the turn the spaces come back in reverse order, so Row 3 takes `A[3]` first.

## Shells in one stitch

```text
Row 1: Ch 14.
Row 2: Sc in 2nd ch from hook, *skip next 2 ch, 5 dc in next ch, skip next 2 ch, sc in next ch; rep from * once more, turn.
Row 3: Ch 3, 2 dc in first sc, *sc in center dc of next shell, 5 dc in next sc; rep from * once more, ending with 3 dc in last sc instead of 5.
```

```cp
# Row 1
14ch,turn
# Row 2
sk,sc,2*[2sk,dc5inc,2sk,sc],turn
# Row 3
3ch,dc2inc,2sk,sc,2sk,dc5inc,2sk,sc,2sk,dc3inc
```

`dc5inc` is 5 dc in one stitch. In Row 3 the chain-3 is not worked into anything, so the first `dc2inc` goes into the first sc; skipping 2 dc of the shell reaches its centre stitch.

## Back loops, post stitches and a colour change

Colours: A = cream, B = teal.

```text
Row 1: With A, ch 9.
Row 2: Sc in 2nd ch from hook and in each ch across, turn. (8)
Row 3: Change to B. Ch 1, sc in back loop only of each st across, turn. (8)
Row 4: Ch 2 (does not count as a st), *fpdc around next st, bpdc around next st; rep from * across. (8)
```

```cp
# Row 1
COLOR: cream
9ch,turn
# Row 2
sk,8sc,turn
# Row 3
COLOR: teal
ch,8scbl,turn
# Row 4
2ch,4*[fpdc,bpdc]
```

A colour change is its own `COLOR:` line, using the colour name chosen for B. The chain-2 is not counted.
