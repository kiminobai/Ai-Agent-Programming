import { Queue, type JobsOptions } from "bullmq";
import { appConfig } from "../config";
import type { BackgroundTask } from "./backgroundTaskRepository";

export const BACKGROUND_TASK_QUEUE_NAME = "kimi-bai-agent-tasks";

// Redis 只保存任务标识和调度元数据；对话、记忆、附件与工作文件仍留在业务存储中。
export const redisConnection = {
  url: appConfig.queue.redisUrl,
  maxRetriesPerRequest: null
};

let queue: Queue | undefined;

export function getBackgroundTaskQueue(): Queue {
  queue ??= new Queue(BACKGROUND_TASK_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: { age: appConfig.queue.completedJobRetentionSeconds },
      removeOnFail: { age: appConfig.queue.failedJobRetentionSeconds }
    }
  });
  return queue;
}

export async function scheduleBackgroundTask(task: BackgroundTask): Promise<void> {
  const options: JobsOptions = {
    jobId: task.taskId,
    attempts: task.maxAttempts,
    backoff: { type: "exponential", delay: appConfig.queue.retryDelayMs }
  };
  await getBackgroundTaskQueue().add(
    task.taskType,
    { taskId: task.taskId, threadId: task.threadId },
    options
  );
}

export async function cancelQueuedBackgroundTask(taskId: string): Promise<void> {
  const job = await getBackgroundTaskQueue().getJob(taskId);
  if (job && ["waiting", "delayed", "paused"].includes(await job.getState())) {
    await job.remove();
  }
}

export async function retryQueuedBackgroundTask(task: BackgroundTask): Promise<void> {
  const existing = await getBackgroundTaskQueue().getJob(task.taskId);
  if (existing) await existing.remove();
  await scheduleBackgroundTask(task);
}

export async function closeBackgroundTaskQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
