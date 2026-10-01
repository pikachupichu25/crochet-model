import { describe, expect, it } from "vitest";
import { segmentPattern } from "../src/segment.ts";
import { ukToUs } from "../src/ukTerms.ts";

describe("ukToUs", () => {
  it("moves each stitch name one step down", () => {
    expect(ukToUs("Rnd 2: 2 dc in each st (12)")).toBe("Rnd 2: 2 sc in each st (12)");
    expect(ukToUs("1 tr, 1 htr, 1 dtr, 1 trtr")).toBe("1 dc, 1 hdc, 1 tr, 1 dtr");
    expect(ukToUs("Treble into next st, double crochet to end")).toBe("Double crochet into next st, single crochet to end");
    expect(ukToUs("half treble crochet, double treble, triple treble")).toBe(
      "half double crochet, treble crochet, double treble crochet",
    );
  });

  it("handles plurals, counts and other vocabulary", () => {
    expect(ukToUs("3 trs, dc2tog, tr3tog, miss 2 sts")).toBe("3 dcs, sc2tog, dc3tog, skip 2 sts");
    expect(ukToUs("Tension: 18 dc")).toBe("Gauge: 18 sc");
    expect(ukToUs("DC in next")).toBe("SC in next");
  });

  it("leaves words that only contain the abbreviations alone", () => {
    expect(ukToUs("Turn, then trace the edge; dcolour, dismiss")).toBe("Turn, then trace the edge; dcolour, dismiss");
  });

  it("turns a detected UK pattern into one that is not flagged", () => {
    const uk = "Rnd 1: 6 dc into ring.\nRnd 2: 2 tr in each st. (12)";
    expect(segmentPattern(uk).ukTerms).toBe(true);
    expect(segmentPattern(ukToUs(uk)).ukTerms).toBe(false);
  });
});
