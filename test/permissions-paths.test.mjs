import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
// Test-only private import: compare behavior with the actual installed tools.
import { resolveReadPathAsync, resolveToCwd } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { evaluatePermission, parsePermissionConfig } from "../extensions/permissions/policy.ts";
import { permissionRequestsForTool, permissionRequestsForToolAsync } from "../extensions/permissions/resources.ts";

const slash = (path) => path.replaceAll("\\", "/");
const config = JSON.parse(readFileSync(new URL("../pi.json", import.meta.url), "utf8"));
const policy = parsePermissionConfig(config);

test("file classifications match installed Pi lexical path resolution", () => {
  for (const cwd of ["/repo", "file:///repo", "~", "/repo\u202fspace"]) {
    for (const path of [
      "src/a.ts", "./src/../a.ts", "../external", "/tmp/external",
      "file:///tmp/external", "file:///repo/%2eenv", "file://localhost/repo/%2eenv",
      "@file:///repo/%2eenv", "@file:///tmp/external", "@src/a.ts", "@@literal",
      "~", "~/private/a", "@~/private/a", "~\\private\\a",
      "src\u00a0space\u2000a\u200ab\u202fc\u205fd\u3000e",
      "file:///repo/raw\u202fspace", "file:///repo/encoded%E2%80%AFspace",
      "%2eenv", "literal%", "literal%ZZ", "literal%2fslash",
      "file:///repo/literal%25", "FILE:///repo/%2eenv", "file:/repo/%2eenv",
      "/c/Users/test", "/mnt/c/Users/test", "/cygdrive/c/Users/test", "//server/share",
    ]) {
      const absolute = resolveToCwd(path, cwd);
      const absoluteCwd = resolveToCwd(".", cwd);
      const rel = relative(absoluteCwd, absolute);
      const external = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
      const expected = [{ permission: "read", resource: slash(external ? absolute : rel || ".") }];
      if (external) {
        expected.push({ permission: "external_directory", resource: slash(resolve(dirname(absolute), "*")) });
      }
      assert.deepEqual(permissionRequestsForTool("read", { path }, cwd), expected, `${cwd}: ${path}`);
    }
  }
});

test("file URLs cannot bypass external-directory and encoded .env asks", () => {
  for (const path of ["file:///tmp/external", "@file:///tmp/external"]) {
    const external = permissionRequestsForTool("read", { path }, "/repo")
      .find((request) => request.permission === "external_directory");
    assert.ok(external, path);
    assert.equal(evaluatePermission(policy.rules, external.permission, external.resource), "ask");
  }
  for (const path of ["file:///repo/%2eenv", "file://localhost/repo/%2eenv", "@file:///repo/%2eenv"]) {
    const [request] = permissionRequestsForTool("read", { path }, "/repo");
    assert.deepEqual(request, { permission: "read", resource: ".env" });
    assert.equal(evaluatePermission(policy.rules, request.permission, request.resource), "ask");
  }
  assert.deepEqual(permissionRequestsForTool("read", { path: "%2eenv" }, "/repo"), [
    { permission: "read", resource: "%2eenv" },
  ]);
});

test("every path adapter rejects malformed file URLs and escaped slashes", () => {
  for (const path of [
    "file:///repo/%", "file:///repo/%ZZ", "file:///repo/%FF", "file://[broken",
    "file://user:pass@localhost/repo/a", "file:///repo/a%2fb", "@file:///repo/a%2Fb",
  ]) {
    assert.throws(() => resolveToCwd(path, "/repo"), undefined, path);
    for (const tool of ["read", "write", "edit", "ls", "grep", "rg", "find"]) {
      assert.throws(() => permissionRequestsForTool(tool, { path, pattern: "*" }, "/repo"), undefined, `${tool}: ${path}`);
    }
  }
  if (process.platform !== "win32") {
    assert.throws(() => permissionRequestsForTool("read", { path: "file://remote/repo/a" }, "/repo"));
  } else {
    assert.throws(() => permissionRequestsForTool("read", { path: "file:///C:/repo/a%5Cb" }, "C:/repo"));
  }
});

test("native read classifications preserve the selected tempfile spelling and cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo\u202fspace");
  await mkdir(cwd);
  for (const name of ["secret\u202fAM.txt", "secret\u202fpm.txt", "quote’s.txt", "cafe\u0301.txt", "cafe\u0301’s.txt"]) {
    await writeFile(join(cwd, name), name);
  }
  const external = join(root, "external\u202fPM.txt");
  await writeFile(external, "external");

  for (const base of [cwd, pathToFileURL(cwd).href]) {
    for (const path of [
      "secret AM.txt", "secret\u202fAM.txt", "@secret\u202fAM.txt", "secret pm.txt",
      "quote's.txt", "café.txt", "café's.txt", "missing AM.txt", "literal%ZZ",
      pathToFileURL(join(cwd, "secret\u202fAM.txt")).href,
      `@${pathToFileURL(join(cwd, "secret AM.txt")).href}`,
      pathToFileURL(join(cwd, "quote's.txt")).href.replace("'", "%27"),
      pathToFileURL(join(cwd, "café's.txt")).href.replace("'", "%27"),
      "../external PM.txt", pathToFileURL(external).href,
    ]) {
      const selected = await resolveReadPathAsync(path, base);
      const absoluteCwd = resolveToCwd(".", base);
      const rel = relative(absoluteCwd, selected);
      const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
      const expected = [{ permission: "read", resource: slash(outside ? selected : rel || ".") }];
      if (outside) expected.push({
        permission: "external_directory", resource: slash(resolve(dirname(selected), "*")),
      });
      assert.deepEqual(await permissionRequestsForToolAsync("read", { path }, base), expected, path);
    }
  }
  assert.deepEqual(await permissionRequestsForToolAsync("read", { path: "secret\u202fAM.txt" }, cwd), [
    { permission: "read", resource: "secret\u202fAM.txt" },
  ]);
  assert.deepEqual(await permissionRequestsForToolAsync("read", { path: "quote's.txt" }, cwd), [
    { permission: "read", resource: "quote’s.txt" },
  ]);
});

test("native read exact target wins; encoded URLs are not normalized a second time", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-exact-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ["exact AM.txt", "exact\u202fAM.txt", "quote's.txt", "quote’s.txt", "encoded\u202fspace.txt"]) {
    await writeFile(join(cwd, name), name);
  }
  for (const [path, resource] of [
    ["exact AM.txt", "exact AM.txt"],
    ["exact\u202fAM.txt", "exact AM.txt"],
    ["quote's.txt", "quote's.txt"],
    [pathToFileURL(join(cwd, "exact\u202fAM.txt")).href, "exact\u202fAM.txt"],
    [pathToFileURL(join(cwd, "encoded\u202fspace.txt")).href, "encoded\u202fspace.txt"],
  ]) {
    const input = Object.freeze({ path });
    assert.equal(await resolveReadPathAsync(path, cwd), join(cwd, resource));
    assert.deepEqual(await permissionRequestsForToolAsync("functions.read", input, cwd), [
      { permission: "read", resource },
    ]);
    assert.equal(input.path, path);
  }
});

test("every read fallback precedence matches native even on normalization-insensitive hosts", async (t) => {
  // Real NFD tempfiles above can also exist under NFC on macOS. Model exact
  // byte spellings here to exercise all fallback branches on every host.
  const cwd = resolve("/repo");
  const path = "café's AM.txt";
  const candidates = [
    resolve(cwd, path),
    resolve(cwd, "café's\u202fAM.txt"),
    resolve(cwd, "cafe\u0301's AM.txt"),
    resolve(cwd, "café’s AM.txt"),
    resolve(cwd, "cafe\u0301’s AM.txt"),
  ];
  let existing = new Set();
  let probes = [];
  t.mock.method(fsPromises, "access", async (candidate) => {
    probes.push(candidate);
    if (!existing.has(candidate)) throw new Error("not accessible");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let mask = 0; mask < 32; mask++) {
    existing = new Set(candidates.filter((_candidate, index) => mask & (1 << index)));
    probes = [];
    const selected = await resolveReadPathAsync(path, cwd);
    const nativeProbes = probes;
    assert.equal(selected, candidates.find((candidate) => existing.has(candidate)) ?? candidates[0]);
    probes = [];
    assert.deepEqual(await permissionRequestsForToolAsync("read", { path }, cwd), [
      { permission: "read", resource: slash(relative(cwd, selected)) },
    ]);
    assert.deepEqual(probes, nativeProbes, `existing mask ${mask}`);
  }
});

test("async read classification rejects malformed input just like the native resolver", async () => {
  for (const path of ["file:///repo/%", "file:///repo/%ZZ", "file:///repo/%FF", "file://[broken", "file:///repo/a%2fb"]) {
    await assert.rejects(resolveReadPathAsync(path, "/repo"));
    await assert.rejects(permissionRequestsForToolAsync("read", { path }, "/repo"));
  }
  for (const path of [undefined, null, 42]) {
    await assert.rejects(permissionRequestsForToolAsync("read", { path }, "/repo"), /read.path must be a string/);
  }
});

test("all directory adapters classify external file URLs", () => {
  for (const tool of ["ls", "grep", "rg", "find"]) {
    assert.equal(permissionRequestsForTool(tool, { path: "file:///tmp/external", pattern: "*" }, "/repo")
      .some((request) => request.permission === "external_directory"), true, tool);
  }
  for (const tool of ["edit", "write"]) {
    assert.equal(permissionRequestsForTool(tool, { path: "file:///repo/%2eenv" }, "/repo")[0].resource, ".env");
  }
});
