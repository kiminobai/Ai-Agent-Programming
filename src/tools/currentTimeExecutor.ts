import { CurrentTimeArguments } from "./currentTimeTool";

export interface CurrentTimeToolResult {
  timeZone: string;
  localTime: string;
  isoUtcTime: string;
  utcOffset: string;
}

function parseArguments(argumentsValue: unknown): CurrentTimeArguments {
  if (!argumentsValue || typeof argumentsValue !== "object") {
    throw new Error("current_time arguments must be an object.");
  }

  const candidate = argumentsValue as Partial<CurrentTimeArguments>;
  const timeZone = candidate.timeZone?.trim();
  if (!timeZone) {
    throw new Error("current_time requires a non-empty timeZone.");
  }

  try {
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
  const { timeZone } = parseArguments(argumentsValue);
  const localTime = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "long",
    hourCycle: "h23",
    timeZone
  }).format(now);
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName");

  return {
    timeZone,
    localTime,
    isoUtcTime: now.toISOString(),
    utcOffset: offsetPart?.value || "UTC offset unavailable"
  };
}
