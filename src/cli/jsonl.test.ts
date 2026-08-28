import { describe, expect, it } from "vitest";
import { parseTaskJsonl } from "./jsonl";

describe("parseTaskJsonl", () => {
  it("parses task jsonl rows", () => {
    const parsed = parseTaskJsonl(
      [
        '{"name":"任务一","role":"se","body":"实现任务一","externalTaskKey":"US-101"}',
        '{"name":"任务二","role":"music","body":"实现任务二"}'
      ].join("\n")
    );

    expect(parsed.tasks).toEqual([
      {
        name: "任务一",
        role: "se",
        body: "实现任务一",
        externalTaskKey: "US-101"
      },
      {
        name: "任务二",
        role: "music",
        body: "实现任务二"
      }
    ]);
  });

  it("fails on invalid json", () => {
    expect(() => parseTaskJsonl('{"name":"任务一"')).toThrow(/Invalid JSONL/);
  });
});
