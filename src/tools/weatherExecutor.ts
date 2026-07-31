/**
 * Weather 的真实执行器。
 * 先解析地点坐标，再从 Open-Meteo 查询当前天气。
 */
import {
  GetWeatherArguments,
  WeatherUnit
} from "./getWeatherTool";

interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  timezone?: string;
}

interface GeocodingResponse {
  results?: GeocodingResult[];
  reason?: string;
}

interface CurrentWeather {
  time: string;
  temperature_2m: number;
  apparent_temperature: number;
  relative_humidity_2m: number;
  precipitation: number;
  weather_code: number;
  wind_speed_10m: number;
}

interface WeatherResponse {
  timezone?: string;
  current?: CurrentWeather;
  current_units?: {
    temperature_2m?: string;
    apparent_temperature?: string;
    relative_humidity_2m?: string;
    precipitation?: string;
    wind_speed_10m?: string;
  };
  reason?: string;
}

export interface WeatherToolResult {
  source: "Open-Meteo";
  location: {
    requested: string;
    resolved: string;
    latitude: number;
    longitude: number;
    timezone?: string;
  };
  current: {
    observedAt: string;
    condition: string;
    temperature: number;
    apparentTemperature: number;
    temperatureUnit: string;
    relativeHumidity: number;
    humidityUnit: string;
    precipitation: number;
    precipitationUnit: string;
    windSpeed: number;
    windSpeedUnit: string;
  };
}

const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "晴朗",
  1: "大部晴朗",
  2: "局部多云",
  3: "阴天",
  45: "有雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "中等毛毛雨",
  55: "强毛毛雨",
  56: "轻微冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "轻微冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "小阵雨",
  81: "中等阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴强冰雹"
};

function parseArguments(argumentsValue: unknown): GetWeatherArguments {
  // 步骤 1：确认 Tool arguments 是对象。
  if (!argumentsValue || typeof argumentsValue !== "object") {
    throw new Error("get_weather arguments must be an object.");
  }

  // 步骤 2：提取地点与单位，并分别检查空值和枚举范围。
  const candidate = argumentsValue as Partial<GetWeatherArguments>;
  const location = candidate.location?.trim();
  const unit = candidate.unit;

  if (!location) {
    throw new Error("get_weather requires a non-empty location.");
  }

  if (unit !== "celsius" && unit !== "fahrenheit") {
    throw new Error("get_weather unit must be celsius or fahrenheit.");
  }

  return { location, unit };
}

async function fetchJson<T>(
  url: URL,
  errorPrefix: string,
  signal?: AbortSignal
): Promise<T> {
  // 通用请求步骤：设置 JSON Accept 和 10 秒超时，避免 Agent 永久等待。
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    },
    signal: requestSignal
  });

  // 第三方可能返回非 JSON 错误页，因此解析失败时统一转为 null。
  const data = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || !data) {
    throw new Error(`${errorPrefix} (${response.status}).`);
  }

  return data;
}

function buildResolvedLocation(location: GeocodingResult): string {
  return [location.name, location.admin1, location.country]
    .filter(Boolean)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join(", ");
}

function buildLocationCandidates(location: string): string[] {
  // 步骤 3：为“中国北京”生成去国家前缀、后缀等多个候选形式。
  const commaParts = location
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const withoutCountryPrefix = location
    .replace(/^(中华人民共和国|中国|PRC)\s*/i, "")
    .trim();
  const withoutCountrySuffix = location
    .replace(/\s*(中华人民共和国|中国|PRC)$/i, "")
    .trim();

  return [
    location,
    withoutCountryPrefix,
    withoutCountrySuffix,
    commaParts[0]
  ].filter(
    (candidate, index, candidates) =>
      candidate.length >= 2 && candidates.indexOf(candidate) === index
  );
}

async function resolveLocation(
  requestedLocation: string,
  signal?: AbortSignal
): Promise<GeocodingResult | undefined> {
  // 步骤 4：逐个调用 Geocoding API，首个命中结果用于天气查询。
  for (const candidate of buildLocationCandidates(requestedLocation)) {
    const geocodingUrl = new URL(
      "https://geocoding-api.open-meteo.com/v1/search"
    );
    geocodingUrl.search = new URLSearchParams({
      name: candidate,
      count: "1",
      language: "zh",
      format: "json"
    }).toString();

    const geocoding = await fetchJson<GeocodingResponse>(
      geocodingUrl,
      "Weather location lookup failed",
      signal
    );
    const match = geocoding.results?.[0];
    if (match) {
      return match;
    }
  }

  return undefined;
}

export async function executeGetWeather(
  argumentsValue: unknown,
  signal?: AbortSignal
): Promise<WeatherToolResult> {
  // 步骤 5：校验模型生成的 Tool arguments。
  const { location, unit } = parseArguments(argumentsValue);
  // 步骤 6：把自然语言地点解析为经纬度与标准时区。
  const resolvedLocation = await resolveLocation(location, signal);

  if (!resolvedLocation) {
    throw new Error(`No weather location matched "${location}".`);
  }

  // 步骤 7：按经纬度组装 Open-Meteo 当前天气请求。
  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  weatherUrl.search = new URLSearchParams({
    latitude: String(resolvedLocation.latitude),
    longitude: String(resolvedLocation.longitude),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "wind_speed_10m"
    ].join(","),
    temperature_unit: unit,
    wind_speed_unit: "kmh",
    timezone: "auto"
  }).toString();

  // 步骤 8：请求真实数据并验证 current 字段存在。
  const weather = await fetchJson<WeatherResponse>(
    weatherUrl,
    "Current weather lookup failed",
    signal
  );

  if (!weather.current) {
    throw new Error(`No current weather was returned for "${location}".`);
  }

  // 步骤 9：转换为项目稳定结构，隔离第三方字段变化。
  return {
    source: "Open-Meteo",
    location: {
      requested: location,
      resolved: buildResolvedLocation(resolvedLocation),
      latitude: resolvedLocation.latitude,
      longitude: resolvedLocation.longitude,
      timezone: weather.timezone || resolvedLocation.timezone
    },
    current: {
      observedAt: weather.current.time,
      condition:
        WEATHER_CODE_DESCRIPTIONS[weather.current.weather_code] ||
        `未知天气代码 ${weather.current.weather_code}`,
      temperature: weather.current.temperature_2m,
      apparentTemperature: weather.current.apparent_temperature,
      temperatureUnit:
        weather.current_units?.temperature_2m ||
        (unit === "celsius" ? "°C" : "°F"),
      relativeHumidity: weather.current.relative_humidity_2m,
      humidityUnit: weather.current_units?.relative_humidity_2m || "%",
      precipitation: weather.current.precipitation,
      precipitationUnit: weather.current_units?.precipitation || "mm",
      windSpeed: weather.current.wind_speed_10m,
      windSpeedUnit: weather.current_units?.wind_speed_10m || "km/h"
    }
  };
}
