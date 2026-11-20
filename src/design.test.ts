import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
const css = readFileSync("web/src/style.css", "utf8");
const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]);
const tokens = (block: string) => [...block.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]);

test("colors are defined only as tokens in :root", () => {
  assert.doesNotMatch(css.replace(/:root\s*\{[^}]*\}/g, ""), COLOR);
  for (const f of readdirSync("web/src").filter((f) => f.endsWith(".tsx"))) {
    assert.doesNotMatch(readFileSync(`web/src/${f}`, "utf8"), COLOR, `${f} has a literal color`);
  }
});

test("every dark-mode token also exists in light mode", () => {
  const light = new Set(tokens(roots[0]));
  for (const t of tokens(roots[1])) assert.ok(light.has(t), `--${t} is only in the dark block`);
});
