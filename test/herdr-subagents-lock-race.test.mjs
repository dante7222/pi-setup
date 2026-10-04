import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a contender born while claims are enumerated is never reaped from an older ps snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-lock-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = new URL("../extensions/herdr-subagents/core.ts", import.meta.url).href;
  const identity = new URL("../extensions/herdr-subagents/identity.ts", import.meta.url).href;
  const claim = join(root, "locks", "abcdef.json");
  const ready = join(root, "ready");
  const released = join(root, "released");
  const contender = join(root, "contender.mjs");
  await writeFile(contender, `import {atomic} from ${JSON.stringify(core)};
import {processIdentity} from ${JSON.stringify(identity)};
import {rm,writeFile} from 'node:fs/promises';
await atomic(${JSON.stringify(claim)}, {pid:process.pid,identity:await processIdentity(),choosing:false,ticket:1});
await writeFile(${JSON.stringify(ready)},'ready');
await new Promise(r=>setTimeout(r,500));
await writeFile(${JSON.stringify(released)},'released');
await rm(${JSON.stringify(claim)},{force:true});`);
  const preload = join(root, "inject.mjs");
  await writeFile(preload, `import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.readdir;let injected=false;
fs.readdir=async function(path,...args){
 if(String(path)===${JSON.stringify(join(root, "locks"))}&&!injected){
  injected=true;const child=spawn(process.execPath,[${JSON.stringify(contender)}],{stdio:'inherit'});
  for(let i=0;i<500&&!existsSync(${JSON.stringify(ready)});i++)await new Promise(r=>setTimeout(r,10));
  if(!existsSync(${JSON.stringify(ready)})){child.kill('SIGKILL');throw new Error('contender failed');}
 }
 return original(path,...args);
};syncBuiltinESMExports();`);
  const program = join(root, "test.mjs");
  await writeFile(program, `import {locked} from ${JSON.stringify(core)};import {existsSync} from 'node:fs';
console.log(await locked({root:${JSON.stringify(root)}},async()=>existsSync(${JSON.stringify(released)})));`);
  const child = spawn(process.execPath, ["--import", preload, program], { stdio: "pipe" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "true", "lock entered before the live contender released its claim");
});
