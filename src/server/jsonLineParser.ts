export interface ParsedJsonLine {
  raw: string;
  value?: Record<string, unknown>;
  error?: string;
}

export class JsonLineAccumulator {
  private pending = "";

  push(chunk: string): ParsedJsonLine[] {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  flush(): ParsedJsonLine[] {
    if (!this.pending) {
      return [];
    }
    const line = this.pending;
    this.pending = "";
    return this.parseLine(line);
  }

  private parseLine(line: string): ParsedJsonLine[] {
    const raw = line.trim();
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return [{ raw, value: parsed as Record<string, unknown> }];
      }
      return [{ raw, error: "JSON line is not an object" }];
    } catch (error) {
      return [{ raw, error: error instanceof Error ? error.message : "Invalid JSON" }];
    }
  }
}
