/**
 * MCP 配置离线验证。
 *
 * 默认 mcp.json 没有启用 Server，因此不会启动子进程或访问网络。
 * 用户启用 Server 后，本脚本会执行真实 Tool Discovery。
 */
import assert from "node:assert/strict";
import {
  closeMcpConnections,
  getMcpServerStatuses,
  initializeMcpTools
} from "../src/mcp/mcpManager";

async function main(): Promise<void> {
  await initializeMcpTools();
  const statuses = getMcpServerStatuses();

  for (const status of statuses) {
    assert.ok(status.name);
    assert.ok(["stdio", "http", "sse"].includes(status.transport));
    assert.ok(Array.isArray(status.toolNames));
  }

  console.log(
    statuses.length === 0
      ? "MCP 配置验证通过：当前没有启用 MCP Server。"
      : `MCP 配置验证完成：${statuses
          .map(
            (status) =>
              `${status.name}=${status.connected ? "connected" : "unavailable"}`
          )
          .join(", ")}`
  );
  await closeMcpConnections();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
