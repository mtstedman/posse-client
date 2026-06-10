import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../lib/shared/format/functions/slug.js";
import {
  parseJobPayload,
  parseJsonObject,
} from "../lib/domains/queue/functions/payload.js";

describe("shared JSON payload helpers", () => {
  it("parses object payloads consistently and falls back to an empty object", () => {
    assert.deepEqual(parseJsonObject({ ok: true }), { ok: true });
    assert.deepEqual(parseJsonObject("{\"ok\":true}"), { ok: true });
    assert.deepEqual(parseJsonObject("[1,2,3]"), {});
    assert.deepEqual(parseJsonObject("{not json"), {});

    assert.deepEqual(parseJobPayload({ payload_json: "{\"task\":\"build\"}" }), { task: "build" });
    assert.deepEqual(parseJobPayload({ payload_json: { task: "build" } }), { task: "build" });
    assert.deepEqual(parseJobPayload({ payload_json: "" }), {});
    const proxiedJob = new Proxy({ row: { payload_json: "{\"proxied\":true}" } }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return target.row?.[prop];
      },
    });
    assert.deepEqual(parseJobPayload(proxiedJob), { proxied: true });
  });
});

describe("shared slug helper", () => {
  it("supports the repo's existing slug alphabets", () => {
    assert.equal(slugify("Build the Thing!", { maxLength: 40 }), "build-the-thing");
    assert.equal(slugify("Skill: Web/API", { alphabet: "id" }), "skill-web-api");
    assert.equal(slugify("Repo.Name v2", { alphabet: "filename" }), "repo.name-v2");
    assert.equal(slugify("Keep/Path Segment", { alphabet: "path" }), "keep/path-segment");
    assert.equal(slugify("...", { fallback: "unknown" }), "unknown");
    assert.equal(slugify("Mixed CASE", { preserveCase: true }), "Mixed-CASE");
  });
});
