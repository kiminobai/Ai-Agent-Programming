import { createHash, randomUUID } from "crypto";
import { sqliteDb } from "../db/sqlite";

export type SubAgentRunStatus = "running" | "succeeded" | "failed";

export type SubAgentRun = {
  runId: string;
  parentRunId?: string;
  threadId: string;
  userId: string;
  turnId?: string;
  roleId: string;
  agentId: string;
  agentLabel: string;
  taskSummary: string;
  depth: 1 | 2;
  status: SubAgentRunStatus;
  toolNames: string[];
  replayed: boolean;
  startedAt: string;
  completedAt?: string;
  errorText?: string;
};

function supervisorRunId(threadId: string, turnId: string): string {
  return createHash("sha256")
    .update(`${threadId}\u0000${turnId}\u0000supervisor`)
    .digest("hex");
}

export function startSubAgentRun(input: {
  threadId: string;
  userId: string;
  turnId: string;
  roleId: string;
  supervisorLabel: string;
  agentId: string;
  agentLabel: string;
  taskSummary: string;
  toolNames: string[];
}): SubAgentRun {
  const parentRunId = supervisorRunId(input.threadId, input.turnId);
  const now = new Date().toISOString();

  // 一级目录每轮只有一个主管任务；多个二级子代理共享这个 parent_run_id。
  sqliteDb.prepare(`
    INSERT OR IGNORE INTO subagent_runs (
      run_id, parent_run_id, thread_id, user_id, turn_id, role_id,
      agent_id, agent_label, task_summary, depth, status,
      tool_names_json, replayed, started_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'supervisor', ?, ?, 1, 'running', '[]', 0, ?)
  `).run(
    parentRunId,
    input.threadId,
    input.userId,
    input.turnId,
    input.roleId,
    input.supervisorLabel,
    "主管正在协调专业子代理",
    now
  );
  // 同一轮可能先后调用多个子代理。后续子代理开始时需要把一级目录重新标记为运行中。
  sqliteDb.prepare(`
    UPDATE subagent_runs
    SET status = 'running', completed_at = NULL, error_text = NULL
    WHERE run_id = ?
  `).run(parentRunId);

  const run: SubAgentRun = {
    runId: randomUUID(),
    parentRunId,
    threadId: input.threadId,
    userId: input.userId,
    turnId: input.turnId,
    roleId: input.roleId,
    agentId: input.agentId,
    agentLabel: input.agentLabel,
    taskSummary: input.taskSummary,
    depth: 2,
    status: "running",
    toolNames: input.toolNames,
    replayed: false,
    startedAt: now
  };

  sqliteDb.prepare(`
    INSERT INTO subagent_runs (
      run_id, parent_run_id, thread_id, user_id, turn_id, role_id,
      agent_id, agent_label, task_summary, depth, status,
      tool_names_json, replayed, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 'running', ?, 0, ?)
  `).run(
    run.runId,
    run.parentRunId,
    run.threadId,
    run.userId,
    run.turnId,
    run.roleId,
    run.agentId,
    run.agentLabel,
    run.taskSummary,
    JSON.stringify(run.toolNames),
    run.startedAt
  );
  return run;
}

export function finishSubAgentRun(
  runId: string,
  status: Exclude<SubAgentRunStatus, "running">,
  options: { replayed?: boolean; errorText?: string } = {}
): void {
  const row = sqliteDb.prepare(`
    SELECT parent_run_id AS parentRunId FROM subagent_runs WHERE run_id = ?
  `).get(runId) as { parentRunId?: string } | undefined;
  const completedAt = new Date().toISOString();
  sqliteDb.prepare(`
    UPDATE subagent_runs
    SET status = ?, replayed = ?, completed_at = ?, error_text = ?
    WHERE run_id = ?
  `).run(
    status,
    options.replayed ? 1 : 0,
    completedAt,
    options.errorText ?? null,
    runId
  );

  if (!row?.parentRunId) {
    return;
  }
  const pending = sqliteDb.prepare(`
    SELECT COUNT(*) AS count
    FROM subagent_runs
    WHERE parent_run_id = ? AND status = 'running'
  `).get(row.parentRunId) as { count: number };
  if (pending.count === 0) {
    const failed = sqliteDb.prepare(`
      SELECT COUNT(*) AS count
      FROM subagent_runs
      WHERE parent_run_id = ? AND status = 'failed'
    `).get(row.parentRunId) as { count: number };
    sqliteDb.prepare(`
      UPDATE subagent_runs
      SET status = ?, completed_at = ?
      WHERE run_id = ?
    `).run(failed.count > 0 ? "failed" : "succeeded", completedAt, row.parentRunId);
  }
}

export function listSubAgentRuns(threadId: string, userId: string): SubAgentRun[] {
  const rows = sqliteDb.prepare(`
    SELECT
      run_id AS runId,
      parent_run_id AS parentRunId,
      thread_id AS threadId,
      user_id AS userId,
      turn_id AS turnId,
      role_id AS roleId,
      agent_id AS agentId,
      agent_label AS agentLabel,
      task_summary AS taskSummary,
      depth,
      status,
      tool_names_json AS toolNamesJson,
      replayed,
      started_at AS startedAt,
      completed_at AS completedAt,
      error_text AS errorText
    FROM subagent_runs
    WHERE thread_id = ? AND user_id = ?
    ORDER BY started_at ASC, depth ASC
  `).all(threadId, userId) as Array<
    Omit<SubAgentRun, "toolNames" | "replayed"> & {
      toolNamesJson: string;
      replayed: number;
    }
  >;
  return rows.map(({ toolNamesJson, replayed, ...row }) => ({
    ...row,
    toolNames: JSON.parse(toolNamesJson) as string[],
    replayed: replayed === 1
  }));
}
