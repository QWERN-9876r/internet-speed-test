import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function startServer(
  handler: RequestListener,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

function runCli(args: string[]): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "speed-test.ts", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("runs parallel cache-busted requests after an excluded warmup", async () => {
  const seenUrls: string[] = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const payload = Buffer.alloc(25 * 1024, 97);
  const { server, url } = await startServer((request, response) => {
    seenUrls.push(request.url ?? "");
    assert.equal(request.headers["cache-control"], "no-cache, no-store, max-age=0");
    assert.equal(request.headers.pragma, "no-cache");
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    setTimeout(() => {
      response.writeHead(200, {
        "content-length": payload.length,
        "cf-cache-status": "HIT",
      });
      response.end(payload, () => {
        activeRequests -= 1;
      });
    }, 40);
  });

  try {
    const result = await runCli([
      `${url}/file`,
      "--count",
      "3",
      "--warmup",
      "1",
      "--cache-bust",
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(seenUrls.length, 4);
    assert.equal(new Set(seenUrls).size, 4, "every URL should have a unique cache-buster");
    assert.ok(maxActiveRequests >= 3, `expected parallel requests, saw ${maxActiveRequests}`);
    assert.match(result.stdout, /01\/3/);
    assert.match(result.stdout, /03\/3/);
    assert.match(result.stdout, /cf-cache-status: HIT/);
    assert.match(result.stdout, /Медианное время/);
    assert.match(result.stdout, /Мин\. \/ макс\. время/);
    assert.match(result.stdout, /Скорость пакета/);
    assert.match(result.stdout, /Скачано всего\s+0\.07 МиБ/);
    assert.doesNotMatch(result.stdout, /Разминка/);
  } finally {
    await closeServer(server);
  }
});

test("prints successful results and exits with an error when one request fails", async () => {
  let requestCount = 0;
  const payload = Buffer.alloc(12 * 1024, 97);
  const { server, url } = await startServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(503, "Service Unavailable").end();
      return;
    }
    response.writeHead(200, { "content-length": payload.length }).end(payload);
  });

  try {
    const result = await runCli([`${url}/partial`, "--count", "2", "--warmup", "0"]);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /ошибка: HTTP 503/);
    assert.match(result.stdout, /Успешно\s+1\/2/);
    assert.match(result.stdout, /Скачано всего\s+0\.01 МиБ/);
    assert.match(result.stdout, /Неудачных запросов: 1/);
  } finally {
    await closeServer(server);
  }
});

test("reports request timeouts", async () => {
  const { server, url } = await startServer((_request, response) => {
    setTimeout(() => response.end("late"), 100);
  });

  try {
    const result = await runCli([
      `${url}/slow`,
      "--count",
      "1",
      "--warmup",
      "0",
      "--timeout",
      "20",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /ошибка:/);
    assert.match(result.stdout, /Нет успешных загрузок/);
  } finally {
    await closeServer(server);
  }
});
