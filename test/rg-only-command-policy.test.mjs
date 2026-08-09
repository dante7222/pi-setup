import assert from "node:assert/strict";
import test from "node:test";
import { invokesGrep } from "../extensions/rg-only/command-policy.ts";

const blockedCommands = [
  "grep foo .",
  "/usr/bin/grep foo file",
  "grep -R foo . | head",
  "printf x && grep foo file",
  "if grep -q foo file; then echo yes; fi",
  "{ grep foo file; }",
  "! { grep -q foo file; }",
  "VAR=1 grep foo file",
  "command grep foo file",
  "env LC_ALL=C grep foo file",
  "sudo grep foo file",
  "time -p grep foo file",
  "xargs grep < files",
  "find . -exec grep foo {} +",
  "find . -exec sh -c 'grep foo \"$1\"' _ {} \\;",
  "bash -lc 'grep foo file'",
  "echo \"$(grep foo file)\"",
  "git grep foo",
];

const allowedCommands = [
  "rg foo .",
  "rg -n grep .",
  "rg -n 'grep' .",
  "printf '%s\\n' grep",
  "echo \"grep foo\"",
  "rg grep file | head",
  "echo '$(grep foo file)'",
  "git status --short",
];

for (const command of blockedCommands) {
  test(`blocks ${command}`, () => {
    assert.equal(invokesGrep(command), true);
  });
}

for (const command of allowedCommands) {
  test(`allows ${command}`, () => {
    assert.equal(invokesGrep(command), false);
  });
}
