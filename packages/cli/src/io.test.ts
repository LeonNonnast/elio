// ───────────────────────────── StdioCliIO: realer readline-Pfad (non-TTY/Pipe) ─────────────────────────────
// Regression für den Resolve-Race in StdioCliIO.prompt: bei gepiptem stdin feuerte readlines `close`
// vor dem question-Callback und löste das Promise mit `undefined` auf -> die getippte Antwort wurde
// verworfen und der Run blieb suspended. Diese Tests treiben den ECHTEN readline-Pfad (kein
// InMemoryCliIO), den die übrigen CLI-Tests umgehen.

import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { StdioCliIO } from "./io";

function sinkWritable(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("StdioCliIO.prompt — real readline path (piped, non-TTY stdin)", () => {
  it("returns the piped answer instead of undefined (no close/question resolve race)", async () => {
    const input = Readable.from(["y\n"]); // a pipe that delivers one line then EOFs
    const out = sinkWritable();
    const io = new StdioCliIO(out.stream, input);

    const answer = await io.prompt("Commit ins Prod-Ziel? [y/N] ");

    expect(answer).toBe("y"); // would be `undefined` against the pre-fix code
    expect(out.text()).toContain("Commit ins Prod-Ziel?"); // the question was written out
  });

  it("returns undefined on EOF with no input (no hang)", async () => {
    const input = Readable.from([]); // immediate EOF, no line
    const out = sinkWritable();
    const io = new StdioCliIO(out.stream, input);

    const answer = await io.prompt("approve? ");

    expect(answer).toBeUndefined();
  });

  it("delivers a multi-char answer line verbatim", async () => {
    const input = Readable.from(["approve please\n"]);
    const out = sinkWritable();
    const io = new StdioCliIO(out.stream, input);

    expect(await io.prompt("? ")).toBe("approve please");
  });
});
