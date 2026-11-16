import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const DEFAULT_REQUEST_COUNT = 10;
const DEFAULT_WARMUP_COUNT = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const BYTES_PER_MIB = 1024 * 1024;
const CACHE_HEADERS = [
  "age",
  "cache-status",
  "cf-cache-status",
  "x-cache",
  "x-vercel-cache",
] as const;

type Options = {
  url: URL;
  count: number;
  warmup: number;
  timeout: number;
  cacheBust: boolean;
};

type DownloadSuccess = {
  ok: true;
  bytes: number;
  duration: number;
  cacheInfo: string[];
};

type DownloadFailure = {
  ok: false;
  duration: number;
  error: string;
};

type DownloadResult = DownloadSuccess | DownloadFailure;

const useColors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function color(text: string, code: number): string {
  return useColors ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function parseInteger(value: string | undefined, option: string, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${option}: укажите целое число от ${min} до ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option}: укажите целое число от ${min} до ${max}`);
  }
  return parsed;
}

function parseArguments(args: string[]): Options {
  let urlArgument: string | undefined;
  let count = DEFAULT_REQUEST_COUNT;
  let warmup = DEFAULT_WARMUP_COUNT;
  let timeout = DEFAULT_TIMEOUT_MS;
  let cacheBust = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--help":
      case "-h":
        console.log(
          "Использование: npm start -- <URL> [--count N] [--warmup N] [--timeout MS] [--cache-bust]",
        );
        process.exit(0);
      case "--count":
        count = parseInteger(args[++index], "--count", 1, 1000);
        break;
      case "--warmup":
        warmup = parseInteger(args[++index], "--warmup", 0, 100);
        break;
      case "--timeout":
        timeout = parseInteger(args[++index], "--timeout", 1, 600_000);
        break;
      case "--cache-bust":
        cacheBust = true;
        break;
      default:
        if (argument.startsWith("-")) {
          throw new Error(`Неизвестный параметр: ${argument}`);
        }
        if (urlArgument) {
          throw new Error("Можно указать только один URL");
        }
        urlArgument = argument;
    }
  }

  if (!urlArgument) {
    throw new Error("Укажите URL: npm start -- https://example.com/image.jpg");
  }

  let url: URL;
  try {
    url = new URL(urlArgument);
  } catch {
    throw new Error("Укажите абсолютный URL с протоколом HTTP или HTTPS");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Поддерживаются только URL с протоколом HTTP или HTTPS");
  }

  return { url, count, warmup, timeout, cacheBust };
}

function requestUrl(url: URL, cacheBust: boolean): string {
  const requestUrl = new URL(url);
  if (cacheBust) {
    requestUrl.searchParams.set("_speed_test", randomUUID());
  }
  return requestUrl.toString();
}

async function download(url: string, timeout: number): Promise<DownloadResult> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
    }

    const cacheInfo = CACHE_HEADERS.flatMap((header) => {
      const value = response.headers.get(header);
      return value ? [`${header}: ${value}`] : [];
    });

    return {
      ok: true,
      bytes,
      duration: (performance.now() - startedAt) / 1000,
      cacheInfo,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      duration: (performance.now() - startedAt) / 1000,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const { url, count, warmup, timeout, cacheBust } = options;

  console.log(`\n${color("╭─ ПРОВЕРКА СКОРОСТИ СКАЧИВАНИЯ", 36)}`);
  console.log(`│ ${color(url.origin, 90)}`);
  console.log(`│ ${count} параллельных запросов · разминка: ${warmup}\n│`);

  for (let index = 0; index < warmup; index += 1) {
    const result = await download(requestUrl(url, cacheBust), timeout);
    if (!result.ok) {
      console.log(`│ ${color("! Разминка", 33)}: ${result.error}`);
    }
  }

  const seriesStartedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: count }, () =>
      download(requestUrl(url, cacheBust), timeout),
    ),
  );
  const seriesDuration = (performance.now() - seriesStartedAt) / 1000;
  const successfulResults = results.filter(
    (result): result is DownloadSuccess => result.ok,
  );
  const failedResults = results.filter(
    (result): result is DownloadFailure => !result.ok,
  );

  for (const [index, result] of results.entries()) {
    const number = `${String(index + 1).padStart(2, "0")}/${count}`;
    if (!result.ok) {
      console.log(`│ ${color("✗", 31)} ${number}  ошибка: ${result.error}`);
      continue;
    }

    const speed = result.duration > 0
      ? (result.bytes / BYTES_PER_MIB / result.duration).toFixed(2)
      : "∞";
    const cacheInfo = result.cacheInfo.length > 0
      ? `  ${color(result.cacheInfo.join(" · "), 90)}`
      : "";
    console.log(
      `│ ${color("✓", 32)} ${number}` +
        `  ${result.duration.toFixed(3).padStart(7)} с` +
        `  ${(result.bytes / BYTES_PER_MIB).toFixed(2).padStart(8)} МиБ` +
        `  ${speed} МиБ/с${cacheInfo}`,
    );
  }

  if (successfulResults.length === 0) {
    console.log(`│\n${color("├─ Нет успешных загрузок", 31)}`);
    console.log(`${color("╰", 36)}`);
    process.exitCode = 1;
    return;
  }

  const totalBytes = successfulResults.reduce((total, result) => total + result.bytes, 0);
  const durations = successfulResults.map((result) => result.duration);
  const averageDuration = durations.reduce((total, duration) => total + duration, 0) /
    durations.length;
  const aggregateSpeed = totalBytes / BYTES_PER_MIB / seriesDuration;
  const summary = [
    ["Успешно", `${successfulResults.length}/${count}`],
    ["Среднее время", `${averageDuration.toFixed(3)} с`],
    ["Медианное время", `${median(durations).toFixed(3)} с`],
    ["Мин. / макс. время", `${Math.min(...durations).toFixed(3)} / ${Math.max(...durations).toFixed(3)} с`],
    ["Скачано всего", `${(totalBytes / BYTES_PER_MIB).toFixed(2)} МиБ`],
    ["Скорость пакета", `${aggregateSpeed.toFixed(2)} МиБ/с`],
  ] as const;
  const labelWidth = Math.max(...summary.map(([label]) => label.length));

  console.log(`│\n${color("├─ ИТОГИ", 36)}`);
  for (const [label, value] of summary) {
    const formattedValue = label === "Скорость пакета" ? color(value, 32) : value;
    console.log(`│ ${label.padEnd(labelWidth)}  ${formattedValue}`);
  }
  if (failedResults.length > 0) {
    console.log(`│ Неудачных запросов: ${failedResults.length}`);
  }
  console.log(`${color("╰", 36)}`);

  if (failedResults.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Ошибка: ${message}`);
  process.exitCode = 1;
});
