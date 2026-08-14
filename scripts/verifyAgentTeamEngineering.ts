import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const testRoot = path.join(process.cwd(), "data", "agent-team-verification");
process.env.KIMIBAI_WORK_DATA_ROOT = path.join(testRoot, "work-data");

async function main() {
  await fs.rm(testRoot, { recursive: true, force: true });
  const [{ estimateTokensFromChars }, dispatcher, snapshots, workspaceTools, database] =
    await Promise.all([
      import("../src/agents/agentTelemetryRepository"),
      import("../src/agents/dynamicSubAgentDispatcher"),
      import("../src/workspace/workspaceTurnSnapshotRepository"),
      import("../src/tools/langchain/workspaceTools"),
      import("../src/db/sqlite")
    ]);

  assert.equal(estimateTokensFromChars(0), 0);
  assert.equal(estimateTokensFromChars(9), 3);

  let transientAttempts = 0;
  const retried = await dispatcher.runWithControlledRetry({
    maxRetries: 2,
    execute: async () => {
      transientAttempts += 1;
      if (transientAttempts < 2) throw new Error("429 rate limit");
      return "ok";
    }
  });
  assert.equal(retried.value, "ok");
  assert.equal(retried.attempts, 2);

  let conflictAttempts = 0;
  await assert.rejects(
    dispatcher.runWithControlledRetry({
      maxRetries: 2,
      execute: async () => {
        conflictAttempts += 1;
        throw new Error("文件发生了变化，检测到冲突");
      }
    }),
    /冲突/
  );
  assert.equal(conflictAttempts, 1, "文件冲突不得自动重试");

  let exhaustedAttempts = 0;
  await assert.rejects(
    dispatcher.runWithControlledRetry({
      maxRetries: 4,
      execute: async () => {
        exhaustedAttempts += 1;
        throw new Error("429 Too Many Requests");
      }
    }),
    /连续失败 5 次，已自动中断/
  );
  assert.equal(exhaustedAttempts, 5, "自动重试必须在总共尝试 5 次后中断");

  const baseTask = {
    specialistId: "reviewer",
    kind: "review" as const,
    task: "审核",
    dependsOn: [] as string[]
  };
  dispatcher.validateTaskGraph([
    { ...baseTask, id: "a" },
    { ...baseTask, id: "b", dependsOn: ["a"] }
  ]);
  assert.throws(() => dispatcher.validateTaskGraph([
    { ...baseTask, id: "a", dependsOn: ["b"] },
    { ...baseTask, id: "b", dependsOn: ["a"] }
  ]), /循环/);

  const content = "用户当前版本";
  const contentHash = snapshots.hashWorkspaceContent(content);
  snapshots.assertWorkspaceVersion({
    threadId: "verification-thread",
    userId: "verification-user",
    turnId: "verification-turn",
    filePath: "safe.txt",
    expectedHash: contentHash,
    current: Buffer.from(content),
    existed: true
  });
  snapshots.assertWorkspaceVersion({
    threadId: "verification-thread",
    userId: "verification-user",
    turnId: "verification-turn",
    filePath: "new.txt",
    expectedHash: "missing",
    current: Buffer.alloc(0),
    existed: false
  });

  const workspace = path.join(testRoot, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "node_modules", "ignored"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "index.ts"), "export {};\n");
  await fs.writeFile(path.join(workspace, "node_modules", "ignored", "x.js"), "ignored");
  const captured = await workspaceTools.captureWorkspaceFiles(workspace);
  assert.ok(captured.has("src/index.ts"));
  assert.equal(captured.has("node_modules/ignored/x.js"), false);
  assert.equal(workspaceTools.buffersEqual(Buffer.from("a"), Buffer.from("a")), true);
  assert.equal(workspaceTools.buffersEqual(Buffer.from("a"), Buffer.from("b")), false);

  database.sqliteDb
    .prepare("DELETE FROM agent_observability_events WHERE thread_id = ?")
    .run("verification-thread");
  database.sqliteDb
    .prepare("DELETE FROM workspace_turn_conflicts WHERE thread_id = ?")
    .run("verification-thread");
  // Windows 会锁定已打开的 SQLite 文件；测试结束前显式关闭两个连接再清理。
  database.workSqliteCheckpointer.db.close();
  database.sqliteCheckpointer.db.close();
  database.workSqliteDb.close();
  database.sqliteDb.close();
  await fs.rm(testRoot, { recursive: true, force: true });
  console.log("Agent 团队工程能力验证通过：预算、重试、DAG、冲突和命令快照均正常。");
}

main().catch(async (error) => {
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
