/**
 * Agent connect handoff tests.
 */
import { describe, it, expect } from "vitest";
import { buildAgentConnectSnippet, revealedTopic } from "./agentConnect.js";

const TOPIC = "fanouttopicabcdef1234";

describe("buildAgentConnectSnippet", () => {
  it("builds the exact aligned config block", () => {
    expect(buildAgentConnectSnippet("https://api.xochi.fi", TOPIC)).toBe(
      "xochi_api_url = https://api.xochi.fi\n" + "topic_id      = fanouttopicabcdef1234",
    );
  });

  it("aligns the = across both lines", () => {
    const [line1, line2] = buildAgentConnectSnippet("https://api.xochi.fi", TOPIC).split("\n");
    expect(line1.indexOf("=")).toBe(line2.indexOf("="));
  });

  it("uses the passed apiUrl verbatim (dev base, nothing hardcoded)", () => {
    const snippet = buildAgentConnectSnippet("http://localhost:8788", TOPIC);
    expect(snippet).toContain("xochi_api_url = http://localhost:8788");
    expect(snippet).not.toContain("api.xochi.fi");
  });

  it("uses the passed topic verbatim", () => {
    expect(buildAgentConnectSnippet("https://api.xochi.fi", "another-topic-000000")).toContain(
      "topic_id      = another-topic-000000",
    );
  });
});

describe("revealedTopic", () => {
  it("stays hidden until revealed", () => {
    expect(revealedTopic(TOPIC, false)).toBeNull();
  });

  it("returns the exact topic once revealed", () => {
    expect(revealedTopic(TOPIC, true)).toBe(TOPIC);
  });
});
