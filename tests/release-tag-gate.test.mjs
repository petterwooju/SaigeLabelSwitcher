import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseCommitMatches,
  inspectReleaseTagContext,
} from "../scripts/verify-release-tag.mjs";

test("release tag gate skips ordinary branch and pull-request refs", () => {
  assert.equal(
    inspectReleaseTagContext(
      {
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_REF_TYPE: "branch",
        GITHUB_SHA: "a".repeat(40),
      },
      "0.0.3",
    ),
    null,
  );
});

test("release tag gate accepts an exact tag and complete event object ID", () => {
  assert.deepEqual(
    inspectReleaseTagContext(
      {
        GITHUB_REF: "refs/tags/v0.0.3",
        GITHUB_REF_NAME: "v0.0.3",
        GITHUB_REF_TYPE: "tag",
        GITHUB_SHA: "b".repeat(40),
      },
      "0.0.3",
    ),
    {
      eventObjectId: "b".repeat(40),
      tagName: "v0.0.3",
    },
  );
});

test("release tag gate rejects tag/version and ref metadata mismatches", () => {
  assert.throws(
    () =>
      inspectReleaseTagContext(
        {
          GITHUB_REF: "refs/tags/v0.0.2",
          GITHUB_REF_NAME: "v0.0.2",
          GITHUB_REF_TYPE: "tag",
          GITHUB_SHA: "c".repeat(40),
        },
        "0.0.3",
      ),
    /expected 'v0\.0\.3'/u,
  );
  assert.throws(
    () =>
      inspectReleaseTagContext(
        {
          GITHUB_REF: "refs/tags/v0.0.3",
          GITHUB_REF_NAME: "v0.0.3",
          GITHUB_REF_TYPE: "branch",
          GITHUB_SHA: "c".repeat(40),
        },
        "0.0.3",
      ),
    /disagree/u,
  );
});

test("release tag gate requires tag, event, and checkout to resolve together", () => {
  assert.doesNotThrow(() =>
    assertReleaseCommitMatches({
      eventCommit: "d".repeat(40),
      headCommit: "d".repeat(40),
      tagCommit: "d".repeat(40),
    }),
  );
  assert.throws(
    () =>
      assertReleaseCommitMatches({
        eventCommit: "d".repeat(40),
        headCommit: "d".repeat(40),
        tagCommit: "e".repeat(40),
      }),
    /tag resolves/u,
  );
  assert.throws(
    () =>
      assertReleaseCommitMatches({
        eventCommit: "e".repeat(40),
        headCommit: "d".repeat(40),
        tagCommit: "d".repeat(40),
      }),
    /GitHub event resolves/u,
  );
});
