# Native subagents: short workflow

Use `codemode` and `tools.subagents(...)` for parent orchestration. Do not wrap the Bash runner in codemode. Without codemode, call native tools directly; without native tools, see [setup/CLI](setup.md). A failed or denied call is not unavailability: surface it, never bypass it. Ordinary workers retain direct tools.

## 1. Discover once

```js
const r = await tools.subagents({action:"help", actions:["prepare","spawn","next"]});
if (!r.ok) throw Error(JSON.stringify(r));
text(r.data.declaration);
```

## 2. Prepare new work — a separate successful call

```js
if (load("herdr.operation")) throw Error("Operation already stored; retry or finish it first.");
const r = await tools.subagents({action:"prepare", tasks:[
  {name:"review-auth", role:"reviewer", prompt:"Review src/auth; report actionable defects with file:line."}
]});
if (!r.ok) throw Error(JSON.stringify(r));
store("herdr.operation", r.data);
text(r.data);
```

Edit the tasks first. Preparation saves them privately and launches nothing; codemode retains only the ID. **Let this call succeed before spawning**: codemode commits stores only on successful scripts. Defaults are chosen at first spawn, not preparation.

## 3. Spawn the stored operation, then work independently

```js
const operation = load("herdr.operation");
if (!operation) throw Error("Missing operation; inspect prior work before preparing new work.");
const r = await tools.subagents({action:"spawn", ...operation});
if (!r.ok) throw Error(JSON.stringify(r));
text(r.data);
```

On response loss, rerun **only spawn** with the stored ID. Never regenerate an ID to bypass uncertainty or launch automatic replacement workers. Failed launches need [inspection](troubleshooting.md#request-id-collisions), not blind replay. After confirmed final cleanup, clear `herdr.operation` with `store("herdr.operation",undefined)` before preparing genuinely new work.

## 4. Repeat one delivery cycle

On the first call the receipt store is empty. On later calls, run this **only after consuming every page from the preceding output**, in a later model call:

```js
const r = await tools.subagents({
  action:"next", acknowledge:load("herdr.receipts") ?? [], seconds:30
});
if (!r.ok) throw Error(JSON.stringify(r));
text(r.data);
store("herdr.receipts", r.data.reports.map(p => p.receipt));
```

`next` acknowledges only the supplied prior receipts, closes eligible jobs, waits, and returns one batch. **Newly returned pages are never acknowledged in that call.** Do not loop this script or issue another cycle before reading its output. One cycle per model call; emit the entire result, without unrelated output.

Check `ok` even when calls resolve; inspect `errors` even when `ok:true`. Failed/cancelled reports are not success.

**Finish only on `finished:true`.** The last complete report has `acknowledgementRequired:true, finished:false`, even with pending zero. Run another cycle to acknowledge and close it. Long reports continue losslessly across cycles.

The whole response shares one **12 KB aggregate budget**, including reports, errors, cleanup and optional progress. Never ack unseen/truncated output. No consuming `collect` from codemode. For lost output or failed calls, use [recovery](troubleshooting.md#native-delivery-recovery).

## Optional controls

Progress is opt-in: for one cycle use `{action:"next", acknowledge:load("herdr.receipts") ?? [], seconds:30, details:true}` instead of the default arguments above. Keep the same emit/read/later-ack steps. Event age is **not a heartbeat or proof of a stall**.

[Result fields, recovery and controls](troubleshooting.md#native-delivery-recovery); [manual workflow](manual.md); [persistent workers](persistent.md); [setup/CLI](setup.md).
