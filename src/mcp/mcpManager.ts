/**
 * MCP Client 管理器。
 *
 * 学习点：当前应用是 MCP Host/Client，外部程序是 MCP Server。
 * MCP Server 暴露的 Tool 会被转换成 LangChain Tool，再进入现有 Agent Loop。
 */
import fs from "node:fs";
import path from "node:path";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

export type McpToolMode = "chat" | "work";
type McpApprovalPolicy = "always" | "mutating" | "never";

type McpServerFileConfig = {
  enabled?: boolean;
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  allowedModes?: McpToolMode[];
  approval?: McpApprovalPolicy;
  allowedTools?: string[];
  disabledTools?: string[];
  timeoutMs?: number;
};

type McpConfigFile = {
  servers?: Record<string, McpServerFileConfig>;
};

export type McpServerStatus = {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: "stdio" | "http" | "sse";
  toolNames: string[];
  error?: string;
};

type LoadedToolPolicy = {
  serverName: string;
  originalName: string;
  allowedModes: McpToolMode[];
  approval: McpApprovalPolicy;
  readOnly: boolean;
};

const SERVER_NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i;
const ENV_REFERENCE_PATTERN = /\$\{env:([A-Z0-9_]+)\}/gi;
const MAX_MCP_SERVERS = 10;
const MAX_MCP_TOOLS = 80;

let client: MultiServerMCPClient | null = null;
let loadedTools: DynamicStructuredTool[] = [];
let toolPolicies = new Map<string, LoadedToolPolicy>();
let statuses: McpServerStatus[] = [];
let initializationPromise: Promise<void> | null = null;

function getConfigPath(): string {
  const configured = process.env.MCP_CONFIG_PATH?.trim();
  return path.resolve(process.cwd(), configured || "mcp.json");
}

function resolveEnvironmentReferences(value: string): string {
  return value.replace(ENV_REFERENCE_PATTERN, (_match, variableName: string) => {
    const resolved = process.env[variableName];
    if (resolved === undefined) {
      throw new Error(`MCP 配置引用了未设置的环境变量：${variableName}`);
    }
    return resolved;
  });
}

function resolveRecordValues(
  values: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      resolveEnvironmentReferences(value)
    ])
  );
}

function resolveServerCwd(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const projectRoot = path.resolve(process.cwd());
  const target = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("MCP stdio cwd 必须位于当前应用项目目录内。");
  }
  return target;
}

function readConfigFile(): McpConfigFile {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { servers: {} };
  }

  const source = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(source) as McpConfigFile;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mcp.json 顶层必须是 JSON 对象。");
  }
  return parsed;
}

function validateServerConfig(
  name: string,
  config: McpServerFileConfig
): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`MCP Server 名称不符合规范：${name}`);
  }
  const transport = config.transport ?? (config.url ? "http" : "stdio");
  if (transport === "stdio" && (!config.command || !Array.isArray(config.args))) {
    throw new Error(`MCP stdio Server ${name} 缺少 command 或 args。`);
  }
  if (transport !== "stdio") {
    if (!config.url) {
      throw new Error(`MCP HTTP Server ${name} 缺少 url。`);
    }
    const url = new URL(config.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`MCP Server ${name} 只允许 http/https URL。`);
    }
  }
  if (
    config.allowedModes?.some((mode) => mode !== "chat" && mode !== "work")
  ) {
    throw new Error(`MCP Server ${name} 包含无效 allowedModes。`);
  }
}

function getOriginalToolName(toolName: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

function isToolEnabled(
  originalName: string,
  config: McpServerFileConfig
): boolean {
  if (config.allowedTools?.length && !config.allowedTools.includes(originalName)) {
    return false;
  }
  return !config.disabledTools?.includes(originalName);
}

function getReadOnlyHint(tool: DynamicStructuredTool): boolean {
  const metadata = tool.metadata as
    | { annotations?: { readOnlyHint?: boolean } }
    | undefined;
  return metadata?.annotations?.readOnlyHint === true;
}

export async function initializeMcpTools(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    const configFile = readConfigFile();
    const allServers = Object.entries(configFile.servers ?? {});
    if (allServers.length > MAX_MCP_SERVERS) {
      throw new Error(`MCP Server 数量不能超过 ${MAX_MCP_SERVERS}。`);
    }

    const enabledServers = allServers.filter(([, config]) => config.enabled);
    statuses = allServers.map(([name, config]) => ({
      name,
      enabled: config.enabled === true,
      connected: false,
      transport: config.transport ?? (config.url ? "http" : "stdio"),
      toolNames: []
    }));
    if (enabledServers.length === 0) {
      return;
    }

    const adapterServers: Record<string, Record<string, unknown>> = {};
    for (const [name, config] of enabledServers) {
      validateServerConfig(name, config);
      const transport = config.transport ?? (config.url ? "http" : "stdio");
      if (transport === "stdio") {
        adapterServers[name] = {
          transport,
          command: resolveEnvironmentReferences(config.command!),
          args: config.args!.map(resolveEnvironmentReferences),
          cwd: resolveServerCwd(config.cwd),
          env: resolveRecordValues(config.env),
          defaultToolTimeout: config.timeoutMs ?? 60_000,
          restart: { enabled: true, maxAttempts: 2, delayMs: 1_000 }
        };
      } else {
        adapterServers[name] = {
          transport,
          url: resolveEnvironmentReferences(config.url!),
          headers: resolveRecordValues(config.headers),
          defaultToolTimeout: config.timeoutMs ?? 60_000,
          reconnect: { enabled: true, maxAttempts: 2, delayMs: 1_000 }
        };
      }
    }

    client = new MultiServerMCPClient({
      mcpServers: adapterServers,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: "mcp",
      useStandardContentBlocks: true,
      throwOnLoadError: false,
      onConnectionError: "ignore"
    } as ConstructorParameters<typeof MultiServerMCPClient>[0]);

    const tools = await client.getTools();
    if (tools.length > MAX_MCP_TOOLS) {
      await client.close();
      client = null;
      throw new Error(`MCP Tool 数量不能超过 ${MAX_MCP_TOOLS}。`);
    }

    const nextTools: DynamicStructuredTool[] = [];
    const nextPolicies = new Map<string, LoadedToolPolicy>();
    for (const [serverName, serverConfig] of enabledServers) {
      const serverTools = tools.filter((tool) =>
        tool.name.startsWith(`mcp__${serverName}__`)
      );
      const acceptedTools = serverTools.filter((tool) =>
        isToolEnabled(getOriginalToolName(tool.name, serverName), serverConfig)
      );
      for (const tool of acceptedTools) {
        nextTools.push(tool);
        nextPolicies.set(tool.name, {
          serverName,
          originalName: getOriginalToolName(tool.name, serverName),
          allowedModes: serverConfig.allowedModes?.length
            ? [...serverConfig.allowedModes]
            : ["work"],
          approval: serverConfig.approval ?? "always",
          readOnly: getReadOnlyHint(tool)
        });
      }

      const status = statuses.find((item) => item.name === serverName);
      if (status) {
        status.connected = acceptedTools.length > 0;
        status.toolNames = acceptedTools.map((tool) => tool.name);
        if (serverTools.length === 0) {
          status.error = "连接失败，或该 Server 没有返回可用 Tool。";
        }
      }
    }
    loadedTools = nextTools;
    toolPolicies = nextPolicies;
  })().catch((error) => {
    const message =
      error instanceof Error ? error.message : "未知 MCP 初始化错误。";
    statuses = statuses.map((status) =>
      status.enabled && !status.connected
        ? { ...status, error: status.error ?? message }
        : status
    );
    console.warn(`MCP 初始化失败，已在不启用 MCP 的情况下继续：${message}`);
    loadedTools = [];
    toolPolicies = new Map();
  });

  return initializationPromise;
}

export function getMcpTools(mode: McpToolMode): DynamicStructuredTool[] {
  return loadedTools.filter((tool) =>
    toolPolicies.get(tool.name)?.allowedModes.includes(mode)
  );
}

export function getMcpApprovalInterrupts(
  mode: McpToolMode
): Record<
  string,
  {
    allowedDecisions: ["approve", "reject"];
    description: string;
  }
> {
  return Object.fromEntries(
    getMcpTools(mode)
      .filter((tool) => {
        const policy = toolPolicies.get(tool.name)!;
        return (
          policy.approval === "always" ||
          (policy.approval === "mutating" && !policy.readOnly)
        );
      })
      .map((tool) => {
        const policy = toolPolicies.get(tool.name)!;
        return [
          tool.name,
          {
            allowedDecisions: ["approve", "reject"] as ["approve", "reject"],
            description: `Agent 准备调用外部 MCP Tool：${policy.serverName}/${policy.originalName}。`
          }
        ];
      })
  );
}

export function getMcpServerStatuses(): McpServerStatus[] {
  return statuses.map((status) => ({
    ...status,
    toolNames: [...status.toolNames]
  }));
}

export async function closeMcpConnections(): Promise<void> {
  await client?.close();
  client = null;
}
