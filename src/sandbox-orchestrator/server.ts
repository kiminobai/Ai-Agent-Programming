import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import express, { type NextFunction, type Request, type Response } from "express";
import * as k8s from "@kubernetes/client-node";
import Docker from "dockerode";

const port = Number(process.env.SANDBOX_ORCHESTRATOR_PORT || 3010);
const namespace = process.env.SANDBOX_NAMESPACE || "kimibai-sandbox";
const serviceToken = process.env.SANDBOX_SERVICE_TOKEN || "";
const storageRoot = process.env.SANDBOX_STORAGE_ROOT || "/var/lib/kimibai-sandboxes";
const pvcName = process.env.SANDBOX_WORKSPACE_PVC || "kimibai-sandbox-workspaces";
const defaultRuntimeClass = process.env.SANDBOX_RUNTIME_CLASS || "gvisor";
const allowedImages = new Set(
  (process.env.SANDBOX_ALLOWED_IMAGES || "node:22-bookworm-slim,python:3.12-slim")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);
const maxTransferBytes = Number(process.env.SANDBOX_MAX_TRANSFER_BYTES || 20 * 1024 * 1024);
const orchestratorBackend = process.env.SANDBOX_ORCHESTRATOR_BACKEND || "kubernetes";

if (serviceToken.length < 32) {
  throw new Error("SANDBOX_SERVICE_TOKEN 必须是至少 32 字符的随机密钥。");
}

let batchApi: k8s.BatchV1Api | null = null;
let coreApi: k8s.CoreV1Api | null = null;
if (orchestratorBackend === "kubernetes") {
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();
  batchApi = kubeConfig.makeApiClient(k8s.BatchV1Api);
  coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
}
const docker = orchestratorBackend === "docker" ? new Docker() : null;
const app = express();
app.use(express.json({ limit: `${Math.ceil(maxTransferBytes / 1024 / 1024) + 2}mb` }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const actual = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(serviceToken);
  const provided = Buffer.from(actual);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    res.status(401).json({ error: "未授权访问 Sandbox Orchestrator。" });
    return;
  }
  next();
}

app.use(authenticate);

function assertSandboxId(value: string): string {
  if (!/^kimibai-[a-f0-9]{24}$/.test(value)) throw new Error("Sandbox ID 不合法。");
  return value;
}

function sandboxDirectory(id: string): string {
  return path.join(storageRoot, assertSandboxId(id));
}

function sandboxWorkspaceDirectory(id: string): string {
  return path.join(sandboxDirectory(id), "workspace");
}

function resolveSandboxFile(id: string, requestedPath: string): string {
  const relative = requestedPath.replace(/\\/g, "/").replace(/^\/workspace\/?/, "");
  if (!relative || relative.split("/").includes("..")) throw new Error("Sandbox 文件路径不合法。");
  const root = sandboxWorkspaceDirectory(id);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Sandbox 文件路径越界。");
  return resolved;
}

async function touchSandbox(id: string): Promise<void> {
  const metadataPath = path.join(sandboxDirectory(id), ".sandbox.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<string, unknown>;
  await fs.writeFile(
    metadataPath,
    JSON.stringify({ ...metadata, updatedAt: new Date().toISOString() }),
    { encoding: "utf8", mode: 0o600 }
  );
}

app.post("/v1/sandboxes", async (req, res) => {
  try {
    const id = assertSandboxId(String(req.body?.sandboxId || ""));
    const image = String(req.body?.image || "node:22-bookworm-slim");
    const runtimeClass = String(req.body?.runtimeClass || defaultRuntimeClass);
    if (!allowedImages.has(image)) throw new Error("执行镜像不在服务端允许列表中。");
    if (!["docker", "gvisor", "kata"].includes(runtimeClass)) throw new Error("RuntimeClass 不受支持。");
    const directory = sandboxDirectory(id);
    const exists = await fs.stat(directory).then(() => true).catch(() => false);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.mkdir(sandboxWorkspaceDirectory(id), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(directory, ".sandbox.json"),
      JSON.stringify({
        id,
        image,
        runtimeClass,
        idleTtlSeconds: Math.max(60, Number(req.body?.idleTtlSeconds || 600)),
        updatedAt: new Date().toISOString()
      }),
      { encoding: "utf8", mode: 0o600 }
    );
    res.status(exists ? 409 : 201).json({ id, status: "ready" });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "创建失败。" });
  }
});

app.put("/v1/sandboxes/:sandboxId/files", async (req, res) => {
  try {
    const id = assertSandboxId(req.params.sandboxId);
    await touchSandbox(id);
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    let total = 0;
    const results = [];
    for (const item of files) {
      try {
        const content = Buffer.from(String(item.contentBase64 || ""), "base64");
        total += content.byteLength;
        if (total > maxTransferBytes) throw new Error("permission_denied");
        const target = resolveSandboxFile(id, String(item.path || ""));
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, content, { mode: 0o600 });
        results.push({ path: item.path, error: null });
      } catch (error) {
        results.push({
          path: String(item.path || ""),
          error: error instanceof Error && error.message === "permission_denied"
            ? "permission_denied"
            : "invalid_path"
        });
      }
    }
    res.json(results);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "上传失败。" });
  }
});

app.post("/v1/sandboxes/:sandboxId/files:download", async (req, res) => {
  try {
    const id = assertSandboxId(req.params.sandboxId);
    await touchSandbox(id);
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 50) : [];
    const results = await Promise.all(
      paths.map(async (requestedPath: string) => {
        try {
          const content = await fs.readFile(resolveSandboxFile(id, requestedPath));
          if (content.byteLength > maxTransferBytes) throw new Error("permission_denied");
          return { path: requestedPath, contentBase64: content.toString("base64"), error: null };
        } catch (error) {
          return {
            path: requestedPath,
            contentBase64: null,
            error: error instanceof Error && error.message === "permission_denied"
              ? "permission_denied"
              : "file_not_found"
          };
        }
      })
    );
    res.json(results);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "下载失败。" });
  }
});

async function waitForJob(jobName: string, timeoutSeconds: number): Promise<void> {
  if (!batchApi) throw new Error("Kubernetes backend 未启动。");
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
    if ((job.status?.succeeded || 0) > 0) return;
    if ((job.status?.failed || 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("远程命令执行超时。");
}

async function ensureDockerImage(image: string): Promise<void> {
  if (!docker) throw new Error("Docker backend 未启动。");
  try {
    await docker.getImage(image).inspect();
  } catch {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) =>
      docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve())
    );
  }
}

async function executeWithDocker(input: {
  sandboxId: string;
  image: string;
  command: string;
  timeoutSeconds: number;
}): Promise<{ output: string; exitCode: number; truncated: boolean }> {
  if (!docker) throw new Error("Docker Engine 不可用，请先启动 Docker Desktop。");
  await docker.ping();
  await ensureDockerImage(input.image);
  const container = await docker.createContainer({
    Image: input.image,
    Cmd: ["/bin/sh", "-lc", input.command],
    Tty: true,
    WorkingDir: "/workspace",
    User: "1000:1000",
    Labels: { "kimibai.sandbox": input.sandboxId },
    Env: ["HOME=/tmp", "TMPDIR=/tmp"],
    NetworkDisabled: true,
    HostConfig: {
      Binds: [`${sandboxWorkspaceDirectory(input.sandboxId)}:/workspace:rw`],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=268435456" }
    }
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await container.start();
    const waitResult = await Promise.race([
      container.wait(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox 命令执行超时。")), input.timeoutSeconds * 1000);
      })
    ]);
    const logs = await container.logs({ stdout: true, stderr: true });
    const output = Buffer.from(logs).toString("utf8");
    return {
      output: output.slice(-20_000),
      exitCode: typeof waitResult.StatusCode === "number" ? waitResult.StatusCode : 1,
      truncated: output.length > 20_000
    };
  } finally {
    if (timer) clearTimeout(timer);
    await container.stop({ t: 1 }).catch(() => undefined);
    await container.remove({ force: true, v: true }).catch(() => undefined);
  }
}

app.post("/v1/sandboxes/:sandboxId/executions", async (req, res) => {
  const id = assertSandboxId(req.params.sandboxId);
  await touchSandbox(id);
  const command = String(req.body?.command || "").trim();
  const timeoutSeconds = Math.min(1800, Math.max(1, Number(req.body?.timeoutSeconds || 900)));
  if (!command || command.length > 20_000) {
    res.status(400).json({ error: "命令为空或超过长度限制。" });
    return;
  }
  const metadata = JSON.parse(
    await fs.readFile(path.join(sandboxDirectory(id), ".sandbox.json"), "utf8")
  ) as { image: string; runtimeClass: string };
  const jobName = `${id}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    if (orchestratorBackend === "docker") {
      res.json(await executeWithDocker({ sandboxId: id, image: metadata.image, command, timeoutSeconds }));
      return;
    }
    if (!batchApi || !coreApi) throw new Error("Kubernetes backend 未启动。");
    await batchApi.createNamespacedJob({
      namespace,
      body: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: jobName, labels: { app: "kimibai-sandbox", sandbox: id } },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: timeoutSeconds,
          ttlSecondsAfterFinished: 300,
          template: {
            metadata: { labels: { app: "kimibai-sandbox", sandbox: id } },
            spec: {
              restartPolicy: "Never",
              runtimeClassName: metadata.runtimeClass || defaultRuntimeClass,
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
              containers: [{
                name: "executor",
                image: metadata.image,
                command: ["/bin/sh", "-lc", command],
                workingDir: "/workspace",
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                  seccompProfile: { type: "RuntimeDefault" }
                },
                resources: {
                  requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "128Mi" },
                  limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" }
                },
                volumeMounts: [
                  { name: "workspace", mountPath: "/workspace", subPath: `${id}/workspace` },
                  { name: "tmp", mountPath: "/tmp" }
                ]
              }],
              volumes: [
                { name: "workspace", persistentVolumeClaim: { claimName: pvcName } },
                { name: "tmp", emptyDir: { sizeLimit: "256Mi" } }
              ]
            }
          }
        }
      }
    });
    await waitForJob(jobName, timeoutSeconds + 10);
    const pods = await coreApi.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
    const pod = pods.items[0];
    const output = pod
      ? await coreApi.readNamespacedPodLog({ name: pod.metadata?.name || "", namespace, container: "executor" })
      : "";
    const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
    const succeeded = (job.status?.succeeded || 0) > 0;
    res.json({ output: String(output).slice(-20000), exitCode: succeeded ? 0 : 1, truncated: String(output).length > 20000 });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "执行失败。" });
  }
});

app.delete("/v1/sandboxes/:sandboxId", async (req, res) => {
  try {
    const id = assertSandboxId(req.params.sandboxId);
    await batchApi?.deleteCollectionNamespacedJob({
      namespace,
      labelSelector: `sandbox=${id}`,
      propagationPolicy: "Background"
    }).catch(() => undefined);
    await fs.rm(sandboxDirectory(id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除失败。" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Sandbox Orchestrator listening on :${port}`);
});

// 清理器只处理由本服务命名的目录；先删除残留 Job，再删除过期文件。
setInterval(async () => {
  const entries = await fs.readdir(storageRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^kimibai-[a-f0-9]{24}$/.test(entry.name)) continue;
    try {
      const metadata = JSON.parse(
        await fs.readFile(path.join(storageRoot, entry.name, ".sandbox.json"), "utf8")
      ) as { updatedAt: string; idleTtlSeconds: number };
      if (Date.now() - Date.parse(metadata.updatedAt) < metadata.idleTtlSeconds * 1000) continue;
      await batchApi?.deleteCollectionNamespacedJob({
        namespace,
        labelSelector: `sandbox=${entry.name}`,
        propagationPolicy: "Background"
      }).catch(() => undefined);
      await fs.rm(path.join(storageRoot, entry.name), { recursive: true, force: true });
    } catch {
      // 单个损坏目录不会阻塞其他 Sandbox 的清理。
    }
  }
}, 60_000).unref();
