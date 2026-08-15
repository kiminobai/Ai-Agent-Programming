import { Worker, type Job } from "bullmq";
import { appConfig } from "../config";
import {
  appendBackgroundTaskEvent,
  getBackgroundTask,
  updateBackgroundTask,
  type BackgroundTask
} from "./backgroundTaskRepository";
import { BACKGROUND_TASK_QUEUE_NAME, redisConnection } from "./backgroundTaskQueue";

export type BackgroundTaskHandler = (
  task: BackgroundTask,
  helpers: {
    signal: AbortSignal;
    progress: (progress: number, stage: string, message: string) => void;
    emit: (event: unknown) => void;
  }
) => Promise<unknown>;

let worker: Worker | undefined;

export async function startBackgroundTaskWorker(
  handler: BackgroundTaskHandler
): Promise<void> {
  if (worker) return;
  worker = new Worker(
    BACKGROUND_TASK_QUEUE_NAME,
    async (job: Job<{ taskId: string; threadId: string }>) => {
      const task = getBackgroundTask(job.data.taskId, job.data.threadId);
      if (!task) throw new Error("任务业务记录不存在，无法执行。");
      const controller = new AbortController();
      const emit = (event: unknown) =>
        appendBackgroundTaskEvent(task.taskId, task.threadId, "stream", event);
      const progress = (value: number, stage: string, message: string) => {
        const normalized = Math.max(0, Math.min(100, value));
        updateBackgroundTask({ taskId: task.taskId, threadId: task.threadId,
          progress: normalized, stage, statusMessage: message });
        emit({ type: "task", task: { taskId: task.taskId, turnId: task.turnId,
          status: "running", progress: normalized, stage,
          statusMessage: message, title: task.title } });
        void job.updateProgress(normalized);
      };

      updateBackgroundTask({ taskId: task.taskId, threadId: task.threadId,
        status: "running", stage: "starting", statusMessage: "正在启动任务",
        attempt: job.attemptsMade + 1, startedAt: new Date().toISOString() });

      // 取消信号保存在本地业务库，Redis 中不会出现 Work 对话、记忆或文件内容。
      const cancellationTimer = setInterval(() => {
        if (getBackgroundTask(task.taskId, task.threadId)?.cancelRequested) {
          controller.abort();
        }
      }, 250);

      try {
        progress(5, "starting", "正在启动任务");
        const result = await handler(task, { signal: controller.signal, progress, emit });
        const latest = getBackgroundTask(task.taskId, task.threadId);
        if (controller.signal.aborted || latest?.cancelRequested) {
          updateBackgroundTask({ taskId: task.taskId, threadId: task.threadId,
            status: "cancelled", stage: "cancelled", statusMessage: "已停止" });
          emit({ type: "error", error: "已停止" });
          return { cancelled: true };
        }
        updateBackgroundTask({ taskId: task.taskId, threadId: task.threadId,
          status: "completed", progress: 100, stage: "completed",
          statusMessage: "已完成", result });
        emit({ type: "task", task: { taskId: task.taskId, turnId: task.turnId,
          status: "completed", progress: 100, stage: "completed",
          statusMessage: "已完成", title: task.title } });
        return result;
      } catch (error) {
        const latest = getBackgroundTask(task.taskId, task.threadId);
        const message = error instanceof Error ? error.message : "后台任务执行失败。";
        if (controller.signal.aborted || latest?.cancelRequested) {
          updateBackgroundTask({ taskId: task.taskId, threadId: task.threadId,
            status: "cancelled", stage: "cancelled", statusMessage: "已停止" });
          emit({ type: "error", error: "已停止" });
          return { cancelled: true };
        }
        const willRetry = job.attemptsMade + 1 < (job.opts.attempts || task.maxAttempts);
        updateBackgroundTask({ taskId: task.taskId, threadId: task.threadId,
          status: willRetry ? "retrying" : "failed",
          stage: willRetry ? "retrying" : "failed",
          statusMessage: willRetry ? "任务失败，正在重试" : "任务失败",
          errorText: message });
        if (!willRetry) emit({ type: "error", error: message });
        throw error;
      } finally {
        clearInterval(cancellationTimer);
      }
    },
    { connection: redisConnection, concurrency: appConfig.queue.workerConcurrency }
  );

  worker.on("error", (error) => console.error("BullMQ Worker 错误：", error));
  await worker.waitUntilReady();
}

export async function stopBackgroundTaskWorker(): Promise<void> {
  await worker?.close();
  worker = undefined;
}
