import { getDatabaseForThread } from "../db/sqlite";

export type TaskPlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskPlanStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskPlanStep {
  id: string;
  title: string;
  status: TaskPlanStepStatus;
}

export interface TaskPlanSnapshot {
  threadId: string;
  turnId: string;
  userId: string;
  title: string;
  status: TaskPlanStatus;
  steps: TaskPlanStep[];
  createdAt: string;
  updatedAt: string;
}

export function saveTaskPlan(input: {
  threadId: string;
  turnId: string;
  userId: string;
  title: string;
  status: TaskPlanStatus;
  steps: TaskPlanStep[];
}): TaskPlanSnapshot {
  const database = getDatabaseForThread(input.threadId);
  const existing = database
    .prepare(
      "SELECT created_at AS createdAt FROM agent_task_plans WHERE thread_id = ? AND turn_id = ?"
    )
    .get(input.threadId, input.turnId) as { createdAt: string } | undefined;
  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || now;

  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO agent_task_plans (
          thread_id, turn_id, user_id, title, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          updated_at = excluded.updated_at`
      )
      .run(
        input.threadId,
        input.turnId,
        input.userId,
        input.title,
        input.status,
        createdAt,
        now
      );
    database
      .prepare(
        "DELETE FROM agent_task_plan_steps WHERE thread_id = ? AND turn_id = ?"
      )
      .run(input.threadId, input.turnId);
    const insertStep = database.prepare(
      `INSERT INTO agent_task_plan_steps (
        thread_id, turn_id, step_id, step_index, title, status
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    input.steps.forEach((step, index) => {
      insertStep.run(
        input.threadId,
        input.turnId,
        step.id,
        index,
        step.title,
        step.status
      );
    });
  })();

  return { ...input, createdAt, updatedAt: now };
}

export function listTaskPlans(
  threadId: string,
  userId: string
): TaskPlanSnapshot[] {
  const database = getDatabaseForThread(threadId);
  const plans = database
    .prepare(
      `SELECT thread_id AS threadId, turn_id AS turnId, user_id AS userId,
              title, status, created_at AS createdAt, updated_at AS updatedAt
       FROM agent_task_plans
       WHERE thread_id = ? AND user_id = ?
       ORDER BY created_at ASC`
    )
    .all(threadId, userId) as Omit<TaskPlanSnapshot, "steps">[];
  const readSteps = database.prepare(
    `SELECT step_id AS id, title, status
     FROM agent_task_plan_steps
     WHERE thread_id = ? AND turn_id = ?
     ORDER BY step_index ASC`
  );
  return plans.map((plan) => ({
    ...plan,
    steps: readSteps.all(threadId, plan.turnId) as TaskPlanStep[]
  }));
}

export function cancelRunningTaskPlan(
  threadId: string,
  turnId?: string
): void {
  if (!turnId) {
    return;
  }
  const database = getDatabaseForThread(threadId);
  database.transaction(() => {
    database
      .prepare(
        `UPDATE agent_task_plans
         SET status = 'cancelled', updated_at = ?
         WHERE thread_id = ? AND turn_id = ? AND status = 'running'`
      )
      .run(new Date().toISOString(), threadId, turnId);
    database
      .prepare(
        `UPDATE agent_task_plan_steps
         SET status = 'cancelled'
         WHERE thread_id = ? AND turn_id = ? AND status = 'in_progress'`
      )
      .run(threadId, turnId);
  })();
}

export function completeRunningTaskPlan(
  threadId: string,
  turnId?: string
): void {
  if (!turnId) {
    return;
  }
  const database = getDatabaseForThread(threadId);
  database.transaction(() => {
    database
      .prepare(
        `UPDATE agent_task_plan_steps
         SET status = 'completed'
         WHERE thread_id = ? AND turn_id = ?
           AND status IN ('pending', 'in_progress')`
      )
      .run(threadId, turnId);
    database
      .prepare(
        `UPDATE agent_task_plans
         SET status = 'completed', updated_at = ?
         WHERE thread_id = ? AND turn_id = ? AND status = 'running'`
      )
      .run(new Date().toISOString(), threadId, turnId);
  })();
}

export function failRunningTaskPlan(
  threadId: string,
  turnId?: string
): void {
  if (!turnId) {
    return;
  }
  const database = getDatabaseForThread(threadId);
  database.transaction(() => {
    database
      .prepare(
        `UPDATE agent_task_plan_steps
         SET status = 'failed'
         WHERE thread_id = ? AND turn_id = ? AND status = 'in_progress'`
      )
      .run(threadId, turnId);
    database
      .prepare(
        `UPDATE agent_task_plans
         SET status = 'failed', updated_at = ?
         WHERE thread_id = ? AND turn_id = ? AND status = 'running'`
      )
      .run(new Date().toISOString(), threadId, turnId);
  })();
}
