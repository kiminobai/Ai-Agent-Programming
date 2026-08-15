import "dotenv/config";

/**
 * OpenTelemetry 统一入口。
 *
 * 只导出运行阶段、模型标识、Token、耗时和状态，不采集 Prompt、消息正文、
 * 文件内容、工具参数或密钥。观察后端不可用时，业务流程仍然继续运行。
 */
import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const serviceName = process.env.OTEL_SERVICE_NAME || "kimibai-agent";
const endpoints = (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINTS ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function exporterHeaders(): Record<string, string> {
  try {
    const parsed = JSON.parse(
      process.env.OTEL_EXPORTER_OTLP_HEADERS_JSON || "{}"
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

const sdk = endpoints.length
  ? new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "1.0.0",
        "deployment.environment.name": process.env.NODE_ENV || "development"
      }),
      spanProcessors: endpoints.map(
        (url) => new BatchSpanProcessor(new OTLPTraceExporter({ url, headers: exporterHeaders() }))
      )
    })
  : null;

if (sdk) {
  sdk.start();
  const shutdown = () => void sdk.shutdown().catch(() => undefined);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const tracer = trace.getTracer("kimibai-agent", "1.0.0");

export function startAppSpan(name: string, attributes: Attributes = {}): Span {
  return tracer.startSpan(name, { attributes });
}

export function finishAppSpan(
  span: Span,
  status: "succeeded" | "failed" | "interrupted",
  attributes: Attributes = {}
): void {
  span.setAttributes(attributes);
  span.setStatus({
    code: status === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    message: status
  });
  span.end();
}

export function recordCompletedSpan(input: {
  name: string;
  status: string;
  durationMs?: number;
  attributes?: Attributes;
}): void {
  const endedAt = Date.now();
  const span = tracer.startSpan(input.name, {
    startTime: endedAt - Math.max(0, input.durationMs || 0),
    attributes: input.attributes
  });
  span.setStatus({
    code: input.status === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    message: input.status
  });
  span.end(endedAt);
}

export function getTelemetryStatus() {
  return {
    enabled: endpoints.length > 0,
    serviceName,
    exporterCount: endpoints.length
  };
}
