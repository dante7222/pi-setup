import assert from "node:assert/strict";
import test from "node:test";
import {
  decideLoopTransition,
  normalizeValidationCommand,
  parseReviewVerdict,
} from "../extensions/supacode-subagents/loop-state.ts";

test("validation commands reject whitespace-only gates", () => {
  assert.equal(normalizeValidationCommand("  npm test  "), "npm test");
  assert.throws(() => normalizeValidationCommand(" \n\t "), /non-whitespace/);
});

test("review verdict must be the final non-empty line", () => {
  assert.equal(parseReviewVerdict("No findings.\n\nVERDICT: PASS\n"), "pass");
  assert.equal(parseReviewVerdict("VERDICT: PASS\nMore analysis"), undefined);
  assert.equal(parseReviewVerdict("Findings\nVERDICT: repair"), "repair");
  assert.equal(parseReviewVerdict("Need product input\nVERDICT: BLOCKED"), "blocked");
});

test("failed checks repair until the attempt budget is exhausted", () => {
  const common = {
    checksPassed: false,
    reviewVerdicts: [],
    candidateFingerprint: "candidate-1",
    previousCandidateFingerprints: new Set(),
  };
  assert.equal(decideLoopTransition({ ...common, attempt: 1, maxAttempts: 3 }).state, "repairing");
  assert.equal(decideLoopTransition({ ...common, attempt: 3, maxAttempts: 3 }).state, "exhausted");
});

test("reviews pass, request repair, or block explicitly", () => {
  const common = {
    attempt: 1,
    maxAttempts: 3,
    checksPassed: true,
    candidateFingerprint: "candidate-1",
    previousCandidateFingerprints: new Set(),
  };
  assert.equal(
    decideLoopTransition({ ...common, reviewVerdicts: ["pass", "pass"] }).state,
    "awaiting_apply",
  );
  assert.equal(
    decideLoopTransition({ ...common, reviewVerdicts: ["pass", "repair"] }).state,
    "repairing",
  );
  assert.equal(
    decideLoopTransition({ ...common, reviewVerdicts: ["pass", "blocked"] }).state,
    "blocked",
  );
  assert.equal(
    decideLoopTransition({ ...common, reviewVerdicts: ["pass", undefined] }).state,
    "blocked",
  );
  assert.equal(
    decideLoopTransition({ ...common, reviewVerdicts: [] }).state,
    "blocked",
  );
});

test("a repeated candidate state cannot be retried into acceptance", () => {
  const transition = decideLoopTransition({
    attempt: 2,
    maxAttempts: 3,
    checksPassed: false,
    reviewVerdicts: [],
    candidateFingerprint: "same-tree",
    previousCandidateFingerprints: new Set(["same-tree"]),
  });
  assert.deepEqual(transition, {
    state: "exhausted",
    reason: "Candidate state repeated without measurable progress; prior gate results cannot be retried as a new acceptance.",
  });
  assert.equal(
    decideLoopTransition({
      attempt: 2,
      maxAttempts: 3,
      checksPassed: true,
      reviewVerdicts: ["pass", "pass"],
      candidateFingerprint: "same-tree",
      previousCandidateFingerprints: new Set(["same-tree"]),
    }).state,
    "exhausted",
  );
});
