#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { scopeFor } from "../../extensions/herdr-subagents/core.ts";
import { claimScope } from "../../extensions/herdr-subagents/ownership.ts";
import { durableDirectory, durableRequest, MAX_FRAME_BYTES, shutdownDurable, startDurable, stopDurable } from "../../extensions/herdr-subagents/durable/transport.ts";
import { runDurableServer } from "../../extensions/herdr-subagents/durable/server.ts";
import { runDurableViewer } from "../../extensions/herdr-subagents/durable/viewer.ts";

const [command, ...args] = process.argv.slice(2);
const emit = (value) => new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve()));
try {
  if (command === "serve") {
    if (args.length !== 1) throw new Error("serve DIRECTORY is internal.");
    await runDurableServer(args[0]);
    // Model/runtime libraries may retain background handles. Storage is closed.
    process.exit(0);
  } else {
    const scope = scopeFor(); // Reject inherited PI_HERDR_WORKER before claiming.
    await claimScope(scope);
    switch (command) {
      case "start":
        if (args.length !== 1 || args[0] !== "--experimental") throw new Error("Usage: durable.mjs start --experimental");
        await emit(await startDurable(scope, true));
        break;
      case "request": {
        if (args.length > 1) throw new Error("Usage: durable.mjs request [file|-]");
        const stream = !args[0] || args[0] === "-" ? process.stdin : createReadStream(args[0]);
        const timer = setTimeout(() => stream.destroy(new Error("Durable request input timed out.")), 30_000);
        const chunks = [];
        let bytes = 0;
        try {
          for await (const chunk of stream) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.length;
            if (bytes > MAX_FRAME_BYTES - 4096) throw new Error("Durable request input is too large.");
            chunks.push(data);
          }
        } finally { clearTimeout(timer); stream.destroy(); }
        await emit(await durableRequest(scope, JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        break;
      }
      case "shutdown":
        if (args.length) throw new Error("shutdown takes no arguments.");
        await shutdownDurable(scope);
        await emit({ paused: true });
        break;
      case "cancel-all":
        if (args.length) throw new Error("cancel-all takes no arguments.");
        await stopDurable(scope);
        await emit({ cancellationRequested: true });
        break;
      case "view":
        if (args.length !== 1) throw new Error("Usage: durable.mjs view ID");
        await runDurableViewer(durableDirectory(scope), args[0], scope);
        break;
      default: throw new Error("Usage: durable.mjs start --experimental | request [file|-] | shutdown | cancel-all | view ID");
    }
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
