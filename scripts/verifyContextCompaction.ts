import assert from "node:assert/strict";
import { getContextCompactionPolicy } from "../src/agents/contextCompactionPolicy";

const original = { ...process.env };
try {
  process.env.AGENT_CONTEXT_WINDOW_TOKENS = "100000";
  process.env.AGENT_TOOL_COMPACT_RATIO = "0.5";
  process.env.AGENT_AUTO_COMPACT_RATIO = "0.72";
  process.env.AGENT_AUTO_COMPACT_MESSAGE_LIMIT = "100";
  process.env.AGENT_COMPACT_KEEP_MESSAGES = "16";
  process.env.AGENT_COMPACT_KEEP_TOOL_RESULTS = "6";

  const policy = getContextCompactionPolicy();
  assert.equal(policy.toolOutputTriggerTokens, 50_000);
  assert.equal(policy.summaryTriggerTokens, 72_000);
  assert.equal(policy.summaryTriggerMessages, 100);
  assert.equal(policy.recentMessagesToKeep, 16);
  assert.equal(policy.recentToolResultsToKeep, 6);
  assert.ok(policy.toolOutputTriggerTokens < policy.summaryTriggerTokens);
  assert.ok(policy.summaryTriggerTokens < policy.contextWindowTokens);
  console.log("上下文自动压缩策略验证通过。", policy);
} finally {
  process.env = original;
}
