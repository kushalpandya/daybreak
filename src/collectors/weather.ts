import type { DaybreakConfig } from "../config.ts";
import type { RunContext } from "../types.ts";

interface OpenMeteoResponse {
  timezone: string;
  current: Record<string, number | string>;
  daily: Record<string, Array<number | string | null>>;
  hourly: Record<string, Array<number | string | null>>;
  current_units?: Record<string, string>;
  daily_units?: Record<string, string>;
}

export async function collectWeather(
  config: NonNullable<DaybreakConfig["weather"]>,
  run: RunContext,
) {
  const temperatureUnit = config.units === "imperial" ? "fahrenheit" : "celsius";
  const windSpeedUnit = config.units === "imperial" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(config.latitude),
    longitude: String(config.longitude),
    timezone: run.timezone,
    forecast_days: "2",
    temperature_unit: temperatureUnit,
    wind_speed_unit: windSpeedUnit,
    current: "temperature_2m,apparent_temperature,weather_code,precipitation,wind_speed_10m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    hourly: "precipitation_probability,precipitation",
  }).toString();

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  const body = await response.json() as OpenMeteoResponse;
  const reportingDate = run.reportingDate;
  const index = body.daily.time?.findIndex((value) => value === reportingDate) ?? -1;
  if (index < 0) throw new Error(`Open-Meteo did not return ${reportingDate}`);

  const precipitationPeriods = body.hourly.time
    .map((time, i) => ({
      time,
      probabilityPercent: body.hourly.precipitation_probability[i],
      amount: body.hourly.precipitation[i],
    }))
    .filter((item) =>
      typeof item.time === "string" && item.time.startsWith(reportingDate) &&
      ((typeof item.probabilityPercent === "number" && item.probabilityPercent >= 30) ||
        (typeof item.amount === "number" && item.amount > 0))
    );

  return {
    data: {
      provider: "open-meteo",
      location: { name: config.name, latitude: config.latitude, longitude: config.longitude },
      timezone: body.timezone,
      units: {
        system: config.units,
        temperature: body.current_units?.temperature_2m,
        precipitation: body.current_units?.precipitation,
        windSpeed: body.current_units?.wind_speed_10m,
      },
      current: {
        observedAt: body.current.time,
        temperature: body.current.temperature_2m,
        apparentTemperature: body.current.apparent_temperature,
        weatherCode: body.current.weather_code,
        condition: weatherCondition(Number(body.current.weather_code)),
        precipitation: body.current.precipitation,
        windSpeed: body.current.wind_speed_10m,
      },
      today: {
        date: reportingDate,
        minimumTemperature: body.daily.temperature_2m_min[index],
        maximumTemperature: body.daily.temperature_2m_max[index],
        precipitationProbabilityPercent: body.daily.precipitation_probability_max[index],
        weatherCode: body.daily.weather_code[index],
        condition: weatherCondition(Number(body.daily.weather_code[index])),
        sunrise: body.daily.sunrise[index],
        sunset: body.daily.sunset[index],
        precipitationPeriods,
      },
    },
  };
}

function weatherCondition(code: number): string {
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code >= 85 && code <= 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "unknown";
}
