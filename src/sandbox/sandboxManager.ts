import crypto from "crypto";
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse
} from "deepagents";
import { appConfig } from "../config";
import {
  deleteSandboxRecord,
  getSandboxRecord,
  saveSandboxRecord
} from "./sandboxRepository";

type ManagedSandbox = BaseSandbox & {
  execute(command: string, options?: { timeout?: number }): Promise<ExecuteResponse>;
};

class KubernetesRemoteSandbox extends BaseSandbox {
  readonly id: string;
  private readonly baseUrl = appConfig.sandbox.orchestratorUrl.replace(/\/$/, "");

  constructor(id: string) {
    super();
    this.id = id;
  }

  private async request<T>(route: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${route}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${appConfig.sandbox.serviceToken}`,
        ...(init?.headers || {})
      }
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Sandbox 服务返回 ${response.status}`);
    return payload;
  }

  execute(command: string, options?: { timeout?: number }): Promise<ExecuteResponse> {
    return this.request(`/v1/sandboxes/${this.id}/executions`, {
      method: "POST",
      body: JSON.stringify({
        command,
        timeoutSeconds: options?.timeout ?? appConfig.sandbox.commandTimeoutSeconds
      })
    });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.request(`/v1/sandboxes/${this.id}/files`, {
      method: "PUT",
      body: JSON.stringify({
        files: files.map(([filePath, content]) => ({
          path: filePath,
          contentBase64: Buffer.from(content).toString("base64")
        }))
      })
    });
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const items = await this.request<Array<{
      path: string;
      contentBase64: string | null;
      error: FileDownloadResponse["error"];
    }>>(`/v1/sandboxes/${this.id}/files:download`, {
      method: "POST",
      body: JSON.stringify({ paths })
    });
    return items.map((item) => ({
      path: item.path,
      content: item.contentBase64
        ? new Uint8Array(Buffer.from(item.contentBase64, "base64"))
        : null,
      error: item.error
    }));
  }
}

const activeSandboxes = new Map<string, ManagedSandbox>();

function assertConfigured(): void {
  if (appConfig.sandbox.provider === "disabled") {
    throw new Error("Sandbox 功能已关闭。请联系管理员启用执行环境。");
  }
  if (appConfig.sandbox.provider === "orchestrator" && !appConfig.sandbox.serviceToken) {
    throw new Error("远程执行环境尚未配置，请联系部署管理员启用 Kubernetes Sandbox 服务。");
  }
}

function stableSandboxId(threadId: string): string {
  return `kimibai-${crypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
}

async function createRemoteSandbox(id: string): Promise<void> {
  const response = await fetch(
    `${appConfig.sandbox.orchestratorUrl.replace(/\/$/, "")}/v1/sandboxes`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${appConfig.sandbox.serviceToken}`
      },
      body: JSON.stringify({
        sandboxId: id,
        image: appConfig.sandbox.image,
        runtimeClass: appConfig.sandbox.runtimeClass,
        idleTtlSeconds: appConfig.sandbox.idleTtlSeconds
      })
    }
  );
  if (!response.ok && response.status !== 409) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || "无法创建远程执行环境。");
  }
}

export async function getOrCreateThreadSandbox(
  threadId: string,
  userId: string
): Promise<ManagedSandbox> {
  assertConfigured();
  const cached = activeSandboxes.get(threadId);
  if (cached) return cached;
  const stored = getSandboxRecord(threadId);
  const id = stored?.sandboxId || stableSandboxId(threadId);
  await createRemoteSandbox(id);
  const backend: ManagedSandbox = new KubernetesRemoteSandbox(id);
  activeSandboxes.set(threadId, backend);
  saveSandboxRecord({
    threadId,
    userId,
    provider: appConfig.sandbox.provider,
    sandboxName: id,
    sandboxId: id,
    status: "ready"
  });
  return backend;
}

export async function destroyThreadSandbox(threadId: string): Promise<void> {
  const record = getSandboxRecord(threadId);
  activeSandboxes.delete(threadId);
  if (record && appConfig.sandbox.provider === "orchestrator") {
    await fetch(
      `${appConfig.sandbox.orchestratorUrl.replace(/\/$/, "")}/v1/sandboxes/${record.sandboxId || record.sandboxName}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${appConfig.sandbox.serviceToken}` }
      }
    ).catch(() => undefined);
  }
  deleteSandboxRecord(threadId);
}

export function isRemoteSandboxEnabled(): boolean {
  return appConfig.sandbox.provider === "orchestrator" && Boolean(appConfig.sandbox.serviceToken);
}
