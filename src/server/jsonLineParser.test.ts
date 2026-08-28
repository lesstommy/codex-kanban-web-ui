import { describe, expect, it } from "vitest";
import { JsonLineAccumulator } from "./jsonLineParser";

describe("JsonLineAccumulator", () => {
  it("parses split JSONL chunks", () => {
    const parser = new JsonLineAccumulator();

    expect(parser.push('{"type":"start"')).toEqual([]);
    expect(parser.push('}\n{"type":"done"}\n')).toEqual([
      { raw: '{"type":"start"}', value: { type: "start" } },
      { raw: '{"type":"done"}', value: { type: "done" } }
    ]);
  });

  it("returns invalid lines as errors", () => {
    const parser = new JsonLineAccumulator();

    const [line] = parser.push("not json\n");
    expect(line.error).toBeTruthy();
    expect(line.raw).toBe("not json");
  });
});
