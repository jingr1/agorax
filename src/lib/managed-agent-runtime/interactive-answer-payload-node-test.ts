import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildAskUserAnswerPayload,
  readOwnAnswer,
  writeOwnAnswer,
  type InteractiveAnswerPayload
} from "./interactive-answer-payload.ts";

describe("buildAskUserAnswerPayload", () => {
  test("derives the human-readable answers list from answersByQuestionId", () => {
    const payload = buildAskUserAnswerPayload({
      "question-1": "Option A",
      "question-2": ["One", "Two"]
    });
    assert.deepEqual(payload, {
      answers: ["Option A", "One, Two"],
      answersByQuestionId: {
        "question-1": "Option A",
        "question-2": ["One", "Two"]
      }
    });
  });

  test("returns the same answersByQuestionId reference it was given", () => {
    const answersByQuestionId = { q: "free text" };
    const payload = buildAskUserAnswerPayload(answersByQuestionId);
    assert.equal(payload.answersByQuestionId, answersByQuestionId);
  });

  test("keeps insertion order so display order matches question order", () => {
    const payload = buildAskUserAnswerPayload({
      b: "second",
      a: "first"
    });
    assert.deepEqual(payload.answers, ["second", "first"]);
  });
});

describe("readOwnAnswer / writeOwnAnswer", () => {
  test("reads own properties only, never inherited ones", () => {
    const proto = { inherited: "no" };
    const values = Object.create(proto) as Record<string, string>;
    values.own = "yes";
    assert.equal(readOwnAnswer(values, "own", "fallback"), "yes");
    assert.equal(readOwnAnswer(values, "inherited", "fallback"), "fallback");
    assert.equal(readOwnAnswer(values, "missing", "fallback"), "fallback");
  });

  test("writeOwnAnswer defines an enumerable, writable, configurable value", () => {
    const values: Record<string, string> = {};
    writeOwnAnswer(values, "q", "a");
    assert.equal(values.q, "a");
    assert.deepEqual(Object.keys(values), ["q"]);
    values.q = "b";
    assert.equal(values.q, "b");
    delete values.q;
    assert.equal("q" in values, false);
  });

  test("round-trips through the payload contract", () => {
    const answersByQuestionId: Record<string, string | string[]> = {};
    writeOwnAnswer(answersByQuestionId, "q1", "alpha");
    writeOwnAnswer(answersByQuestionId, "q2", ["beta", "gamma"]);
    const payload: InteractiveAnswerPayload =
      buildAskUserAnswerPayload(answersByQuestionId);
    assert.equal(readOwnAnswer(payload.answersByQuestionId, "q1", ""), "alpha");
    assert.deepEqual(
      readOwnAnswer(payload.answersByQuestionId, "q2", []),
      ["beta", "gamma"]
    );
  });
});
