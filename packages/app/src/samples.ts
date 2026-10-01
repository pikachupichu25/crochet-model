// The sample library (FR-1.5). Patterns and translations are our own; the
// translations ship with the app, so samples need no key (SPEC §8.2). `cp`
// has one entry per row that segmentPattern finds, in order.

export interface Sample {
  id: string;
  name: string;
  blurb: string;
  dimension: 2 | 3;
  english: string;
  cp: string[];
}

const repeat = (line: string, n: number) => Array.from({ length: n }, () => line).join("\n");

export const SAMPLES: Sample[] = [
  {
    id: "swatch",
    name: "Flat swatch",
    blurb: "Rows of single crochet, turned at each end",
    dimension: 2,
    english: [
      "Row 1: Ch 16.",
      "Row 2: Sc in 2nd ch from hook and in each ch across, turn. (15)",
      "Rows 3-10: Ch 1, sc in each st across, turn. (15)",
      "Fasten off.",
    ].join("\n"),
    cp: ["16ch,turn", "sk,15sc,turn", repeat("ch,15sc,turn", 8)],
  },
  {
    id: "granny",
    name: "Granny square",
    blurb: "Clusters of three in chain spaces, joined rounds",
    dimension: 2,
    english: [
      "Ch 4, join with sl st to form a ring.",
      "Rnd 1: Ch 3 (counts as dc), 2 dc in ring, ch 2, (3 dc in ring, ch 2) 3 times, join with sl st to top of ch-3.",
      "Rnd 2: Sl st into next ch-2 sp, ch 3 (counts as dc), (2 dc, ch 2, 3 dc) in same sp, ch 1, *(3 dc, ch 2, 3 dc) in next ch-2 sp, ch 1; rep from * 2 more times, join with sl st to top of ch-3.",
      "Rnd 3: Sl st into next ch-2 sp, ch 3 (counts as dc), (2 dc, ch 2, 3 dc) in same sp, ch 1, 3 dc in next ch-1 sp, ch 1, *(3 dc, ch 2, 3 dc) in next ch-2 sp, ch 1, 3 dc in next ch-1 sp, ch 1; rep from * 2 more times, join with sl st to top of ch-3.",
      "Fasten off.",
    ].join("\n"),
    cp: [
      "4ch.R,ss@[%,0]",
      "3ch,2dc@R,2ch.A[0],3dc@R,2ch.A[1],3dc@R,2ch.A[2],3dc@R,2ch.A[3],ss@[%,2]",
      "ss@A[0],3ch,2dc@A[0],2ch.B[0],3dc@A[0],ch.C[0],3dc@A[1],2ch.B[1],3dc@A[1],ch.C[1],3dc@A[2],2ch.B[2],3dc@A[2],ch.C[2],3dc@A[3],2ch.B[3],3dc@A[3],ch.C[3],ss@[%,3]",
      "ss@B[0],3ch,2dc@B[0],2ch,3dc@B[0],ch,3dc@C[0],ch,3dc@B[1],2ch,3dc@B[1],ch,3dc@C[1],ch,3dc@B[2],2ch,3dc@B[2],ch,3dc@C[2],ch,3dc@B[3],2ch,3dc@B[3],ch,3dc@C[3],ch,ss@[%,3]",
    ],
  },
  {
    id: "ball",
    name: "Amigurumi ball",
    blurb: "Spiral rounds from a magic ring, increased then decreased",
    dimension: 3,
    english: [
      "Rnd 1: 6 sc in magic ring. (6)",
      "Rnd 2: 2 sc in each st around. (12)",
      "Rnd 3: (Sc in next st, 2 sc in next st) 6 times. (18)",
      "Rnd 4: (Sc in next 2 sts, 2 sc in next st) 6 times. (24)",
      "Rnds 5-8: Sc in each st around. (24)",
      "Rnd 9: (Sc in next 2 sts, sc2tog) 6 times. (18)",
      "Rnd 10: (Sc in next st, sc2tog) 6 times. (12)",
      "Rnd 11: Sc2tog 6 times. (6)",
      "Fasten off.",
    ].join("\n"),
    cp: [
      "ring.R\n6sc@R",
      "6*sc2inc",
      "6*[sc,sc2inc]",
      "6*[2sc,sc2inc]",
      repeat("24sc", 4),
      "6*[2sc,sc2tog]",
      "6*[sc,sc2tog]",
      "6*sc2tog",
    ],
  },
  {
    id: "hat",
    name: "Beanie",
    blurb: "A flat crown that turns down into a tube",
    dimension: 3,
    english: [
      "Rnd 1: 6 sc in magic ring. (6)",
      "Rnd 2: 2 sc in each st around. (12)",
      "Rnd 3: (Sc in next st, 2 sc in next st) 6 times. (18)",
      "Rnd 4: (Sc in next 2 sts, 2 sc in next st) 6 times. (24)",
      "Rnd 5: (Sc in next 3 sts, 2 sc in next st) 6 times. (30)",
      "Rnd 6: (Sc in next 4 sts, 2 sc in next st) 6 times. (36)",
      "Rnd 7: (Sc in next 5 sts, 2 sc in next st) 6 times. (42)",
      "Rnds 8-19: Sc in each st around. (42)",
      "Rnd 20: Sc in back loop only of each st around. (42)",
      "Rnds 21-22: Sc in each st around. (42)",
      "Fasten off.",
    ].join("\n"),
    cp: [
      "ring.R\n6sc@R",
      "6*sc2inc",
      "6*[sc,sc2inc]",
      "6*[2sc,sc2inc]",
      "6*[3sc,sc2inc]",
      "6*[4sc,sc2inc]",
      "6*[5sc,sc2inc]",
      repeat("42sc", 12),
      "42scbl",
      repeat("42sc", 2),
    ],
  },
];
