import assert from "node:assert/strict";
import test from "node:test";
import {
  enabledReviewerProfiles,
  reviewerProfiles,
} from "../extensions/supacode-subagents/reviewer-profiles.ts";

test("configured delegate-loop reviewer profiles are valid", () => {
  const enabled = enabledReviewerProfiles();
  assert.ok(enabled.length >= 1);
  assert.ok(enabled.length <= 4);
  assert.equal(new Set(enabled.map((profile) => profile.id)).size, enabled.length);
  for (const profile of enabled) {
    assert.ok(profile.title.trim());
    assert.ok(profile.prompt.trim());
    assert.ok(Array.isArray(profile.skills));
  }
  assert.equal(reviewerProfiles.length >= enabled.length, true);
});

test("reviewer profile validation rejects ambiguous configuration", () => {
  const profile = {
    id: "correctness",
    enabled: true,
    title: "correctness",
    prompt: "review correctness",
    skills: [],
  };
  assert.throws(
    () => enabledReviewerProfiles([profile, { ...profile }]),
    /Duplicate reviewer profile ID/,
  );
  assert.throws(
    () => enabledReviewerProfiles([{ ...profile, id: "Bad ID" }]),
    /lowercase words/,
  );
  assert.throws(
    () => enabledReviewerProfiles([{ ...profile, prompt: "  " }]),
    /empty prompt/,
  );
  assert.throws(
    () => enabledReviewerProfiles([{ ...profile, skills: ["  "] }]),
    /empty skill path/,
  );
});
