import { performance } from "node:perf_hooks";

const REQUEST_COUNT = 10;
const BYTES_PER_MIB = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

async function download(url: string): Promise<{ bytes: number; duration: number }> {
  const startedAt = performance.now();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("The response has no body");
  }

  let bytes = 0;
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

  return { bytes, duration: (performance.now() - startedAt) / 1000 };
}

async function main(): Promise<void> {
  const urlArgument = process.argv[2];
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

  let totalBytes = 0;
  let totalRequestTime = 0;
  const seriesStartedAt = performance.now();

  for (let requestNumber = 1; requestNumber <= REQUEST_COUNT; requestNumber += 1) {
    const result = await download(url.toString());
    totalBytes += result.bytes;
    totalRequestTime += result.duration;
    console.log(
      `Запрос ${requestNumber}/${REQUEST_COUNT}: ${result.duration.toFixed(3)} с, ` +
        `${(result.bytes / BYTES_PER_MIB).toFixed(2)} МиБ`,
    );
  }

  const seriesDuration = (performance.now() - seriesStartedAt) / 1000;
  console.log(`\nСреднее время запроса: ${(totalRequestTime / REQUEST_COUNT).toFixed(3)} с`);
  console.log(`Всего скачано: ${(totalBytes / BYTES_PER_MIB).toFixed(2)} МиБ`);
  console.log(
    `Скорость скачивания: ${(totalBytes / BYTES_PER_MIB / seriesDuration).toFixed(2)} МиБ/с`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Ошибка: ${message}`);
  process.exitCode = 1;
});
