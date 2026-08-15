import { closeMcpConnections, initializeMcpTools } from "./mcp/mcpManager";
import { executeAgentChatTask } from "./tasks/agentChatTaskHandler";
import { startBackgroundTaskWorker, stopBackgroundTaskWorker } from "./tasks/backgroundTaskWorker";

async function startWorker(): Promise<void> {
  // Worker 也需要完成 MCP Tool Discovery，才能恢复与 API 进程相同的 Agent 能力。
  await initializeMcpTools();
  await startBackgroundTaskWorker(executeAgentChatTask);
  console.log("BullMQ Worker 已启动，正在等待 Agent 任务。");
}

async function shutdown(): Promise<void> {
  await stopBackgroundTaskWorker();
  await closeMcpConnections();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

void startWorker().catch((error) => {
  console.error("BullMQ Worker 启动失败：", error);
  process.exitCode = 1;
});
