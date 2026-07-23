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
  if (!argumentsValue || typeof argumentsValue !== "object") {
    throw new Error("get_weather arguments must be an object.");
  }

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

async function fetchJson<T>(url: URL, errorPrefix: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(10_000)
  });

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
  requestedLocation: string
): Promise<GeocodingResult | undefined> {
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
      "Weather location lookup failed"
    );
    const match = geocoding.results?.[0];
    if (match) {
      return match;
    }
  }

  return undefined;
}

export async function executeGetWeather(
  argumentsValue: unknown
): Promise<WeatherToolResult> {
  const { location, unit } = parseArguments(argumentsValue);
  const resolvedLocation = await resolveLocation(location);

  if (!resolvedLocation) {
    throw new Error(`No weather location matched "${location}".`);
  }

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

  const weather = await fetchJson<WeatherResponse>(
    weatherUrl,
    "Current weather lookup failed"
  );

  if (!weather.current) {
    throw new Error(`No current weather was returned for "${location}".`);
  }

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
