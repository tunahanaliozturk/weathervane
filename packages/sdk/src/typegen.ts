#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { FlagDefinition } from "@weathervane/core";
import { renderTypes } from "./render-types.ts";

const usage = `Usage: WEATHERVANE_SDK_KEY=<key> weathervane-typegen --base-url <url> --out <file.d.ts>

Reads the ruleset of the key's environment and writes a declaration for typed flag reads.
The key comes from the environment so it stays out of shell history and process listings.`;

const { values } = parseArgs({
  options: { "base-url": { type: "string" }, out: { type: "string" }, help: { type: "boolean" } },
});
const baseUrl = values["base-url"];
const out = values.out;
const key = process.env["WEATHERVANE_SDK_KEY"];
if (values.help === true || baseUrl === undefined || out === undefined || key === undefined) {
  process.stderr.write(`${usage}\n`);
  process.exit(values.help === true ? 0 : 2);
}

const response = await fetch(new URL("/sdk/v1/ruleset", baseUrl), {
  headers: { authorization: `Bearer ${key}` },
});
if (!response.ok) {
  process.stderr.write(`weathervane-typegen: ${response.status} ${await response.text()}\n`);
  process.exit(1);
}
const ruleset = (await response.json()) as { version: number; flags: FlagDefinition[] };
await writeFile(out, renderTypes(ruleset.version, ruleset.flags));
process.stdout.write(`wrote ${ruleset.flags.length} flags to ${out}\n`);
