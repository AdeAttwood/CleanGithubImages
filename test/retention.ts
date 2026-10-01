import { strict as assert } from "node:assert";
import { test, TestContext } from "node:test";
import { run } from "../src/run";

function version(id: number, tags: string[]) {
  return {
    id,
    created_at: new Date(Date.UTC(2026, 0, id)).toISOString(),
    metadata: { container: { tags } },
  };
}

function setup(t: TestContext, inputs: Record<string, string> = {}) {
  const previous = { ...process.env };
  for (const [name, value] of Object.entries({
    org: "example", package: "image", user: "", keep: "1",
    "tag-pattern": "^run-[0-9]+$", "pr-pattern": "^pr-([0-9]+)$", ...inputs,
  })) {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }
  t.after(() => { process.env = previous; });
}

function mockApi(
  t: TestContext,
  pages: ReturnType<typeof version>[][],
  pullRequests = [[{ number: 42 }], []],
  failure = "",
) {
  const deleted: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "DELETE") {
      if (failure === "delete") return Response.json({}, { status: 403 });
      deleted.push(Number(url.split("/").pop()));
      return new Response(null, { status: 204 });
    }
    if (url.includes("/pulls?")) {
      if (failure === "pulls") return Response.json({}, { status: 403 });
      return Response.json(pullRequests.shift());
    }
    if (url.includes("/versions?")) {
      if (failure === "versions" && pages.length === 1) {
        return Response.json({}, { status: 403 });
      }
      return Response.json(pages.shift());
    }
    return Response.json({ repository: { full_name: "example/repo" } });
  });
  return deleted;
}

test("cleans PR, matching, and untagged versions together across pages", async (t) => {
  setup(t);
  const deleted = mockApi(t, [
    [version(1, ["run-1"]), version(2, []), version(3, ["pr-1"])],
    [version(4, ["run-4", "run-5"]), version(5, []), version(6, ["pr-42"])],
    [version(7, ["run-7", "main"]), version(8, ["v1"])],
    [],
  ]);
  await run();
  assert.deepEqual(deleted.sort(), [1, 2, 3]);
});

test("custom PR regex protects open PRs from later pages and broad tag patterns", async (t) => {
  setup(t, { "pr-pattern": "^preview-([0-9]+)-image$", "tag-pattern": ".*", keep: "0" });
  const deleted = mockApi(t, [
    [version(1, ["preview-42-image", "run-1"]), version(2, ["preview-2-image"])], [],
  ], [[{ number: 7 }], [{ number: 42 }], []]);
  await run();
  assert.deepEqual(deleted, [2]);
});

test("mixed closed-PR and matching tags follow pattern retention", async (t) => {
  setup(t);
  const deleted = mockApi(t, [
    [version(1, ["run-1", "pr-1"]), version(2, ["run-2", "pr-2"])], [],
  ]);
  await run();
  assert.deepEqual(deleted, [1]);
});

test("zero keep deletes all eligible versions, including the oldest untagged", async (t) => {
  setup(t, { keep: "0" });
  const deleted = mockApi(t, [[version(1, []), version(2, ["run-2"])], []]);
  await run();
  assert.deepEqual(deleted.sort(), [1, 2]);
});

test("without tag-pattern only PR and untagged cleanup runs", async (t) => {
  setup(t, { "tag-pattern": "", "pr-pattern": "" });
  const deleted = mockApi(t, [[
    version(1, []), version(2, []), version(3, ["run-3"]), version(4, ["pr-1"]),
  ], []]);
  await run();
  assert.deepEqual(deleted.sort(), [1, 4]);
});

test("keep defaults to ten versions per retention group", async (t) => {
  setup(t, { keep: "" });
  const versions = Array.from({ length: 11 }, (_, i) => version(i + 1, []));
  versions.push(...Array.from({ length: 11 }, (_, i) => version(i + 12, [`run-${i}`])));
  const deleted = mockApi(t, [versions, []]);
  await run();
  assert.deepEqual(deleted, [1, 12]);
});

test("invalid inputs fail before making requests", async (t) => {
  setup(t);
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected request");
  });
  for (const keep of ["-1", "1.5", "abc", "9007199254740992"]) {
    process.env.INPUT_KEEP = keep;
    await assert.rejects(run(), /keep/);
  }
  process.env.INPUT_KEEP = "1";
  process.env["INPUT_TAG-PATTERN"] = "[";
  await assert.rejects(run(), SyntaxError);
  process.env["INPUT_TAG-PATTERN"] = "";
  process.env["INPUT_PR-PATTERN"] = "[";
  await assert.rejects(run(), SyntaxError);
  assert.equal(fetch.mock.callCount(), 0);
});

test("PR regex leaves non-matching tags protected", async (t) => {
  setup(t, { "pr-pattern": "^preview-([0-9]+)-image$" });
  const deleted = mockApi(t, [[
    version(1, ["preview-2-image"]), version(2, ["preview-2-other"]),
    version(3, ["pr-3"]),
  ], []]);
  await run();
  assert.deepEqual(deleted, [1]);
});

for (const pattern of ["^pr-[0-9]+$", "^(pr)-[0-9]+$"]) {
  test(`invalid PR capture in ${pattern} prevents all deletions`, async (t) => {
    setup(t, { "pr-pattern": pattern, keep: "0" });
    const deleted = mockApi(t, [[version(1, []), version(2, ["pr-2"])], []]);
    await assert.rejects(run(), /first capture group/);
    assert.deepEqual(deleted, []);
  });
}

test("invalid creation dates prevent deletion", async (t) => {
  setup(t, { keep: "0" });
  const deleted = mockApi(t, [[{ ...version(1, []), created_at: "invalid" }], []]);
  await assert.rejects(run(), /date/);
  assert.deepEqual(deleted, []);
});

for (const failure of ["pulls", "versions", "delete"]) {
  test(`${failure} API failures fail cleanup`, async (t) => {
    setup(t, { keep: "0" });
    const deleted = mockApi(t, [[version(1, ["run-1"])], []], [[]], failure);
    await assert.rejects(run(), /Failed/);
    assert.deepEqual(deleted, []);
  });
}
