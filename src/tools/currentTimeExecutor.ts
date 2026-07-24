/**
 * Current Time 的本地执行器。
 * 使用 Intl 校验 IANA 时区并格式化真实系统时间。
 */
import { CurrentTimeArguments } from "./currentTimeTool";

export interface CurrentTimeToolResult {
  timeZone: string;
  localTime: string;
  isoUtcTime: string;
  utcOffset: string;
}

function parseArguments(argumentsValue: unknown): CurrentTimeArguments {
  // 步骤 1：确认模型传入对象。
  if (!argumentsValue || typeof argumentsValue !== "object") {
    throw new Error("current_time arguments must be an object.");
  }

  const candidate = argumentsValue as Partial<CurrentTimeArguments>;
  // 步骤 2：去除空格并拒绝空时区。
  const timeZone = candidate.timeZone?.trim();
  if (!timeZone) {
    throw new Error("current_time requires a non-empty timeZone.");
  }

  try {
    // 步骤 3：Intl 会对未知 IANA 时区抛出 RangeError。
    new Intl.DateTimeFormat("zh-CN", { timeZone }).format();
  } catch {
    throw new Error(
      `current_time received an invalid IANA time zone: "${timeZone}".`
    );
  }

  return { timeZone };
}

export function executeCurrentTime(
  argumentsValue: unknown,
  now: Date = new Date()
): CurrentTimeToolResult {
  // 步骤 4：只使用通过校验的标准时区。
  const { timeZone } = parseArguments(argumentsValue);
  // 步骤 5：按中文完整日期时间格式输出当地时间。
  const localTime = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "long",
    hourCycle: "h23",
    timeZone
  }).format(now);
  // 步骤 6：另外提取 GMT/UTC 偏移，便于模型清晰回答。
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName");

  // 步骤 7：同时返回当地时间和 UTC 时间，避免时区歧义。
  return {
    timeZone,
    localTime,
    isoUtcTime: now.toISOString(),
    utcOffset: offsetPart?.value || "UTC offset unavailable"
  };
}
