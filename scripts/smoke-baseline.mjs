import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.SMOKE_PORT || 9321);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const GEMINI_API_KEY = String(process.env.SMOKE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
const TTS_API = String(process.env.SMOKE_TTS_API || "https://apitts.ghost1.cloud").trim();
const TTS_SECRET = String(process.env.SMOKE_TTS_SECRET || "abelhadomato").trim();
const USE_EXISTING_SERVER = ["1", "true", "yes", "on"].includes(String(process.env.SMOKE_USE_EXISTING_SERVER || "").trim().toLowerCase());
const ENABLE_CHAT_SMOKE = ["1", "true", "yes", "on"].includes(String(process.env.SMOKE_ENABLE_CHAT || "").trim().toLowerCase());
const ENABLE_TTS_SMOKE = ["1", "true", "yes", "on"].includes(String(process.env.SMOKE_ENABLE_TTS || "").trim().toLowerCase());

const results = [];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function mark(name, status, detail = "") {
  results.push({ name, status, detail });
  const suffix = detail ? ` - ${detail}` : "";
  log(`[${status}] ${name}${suffix}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createCookieJar() {
  const store = new Map();
  return {
    setFromResponse(response) {
      const setCookie = response.headers.get("set-cookie");
      if (!setCookie) return;
      const firstPart = setCookie.split(";")[0];
      const eqIndex = firstPart.indexOf("=");
      if (eqIndex <= 0) return;
      const key = firstPart.slice(0, eqIndex).trim();
      const value = firstPart.slice(eqIndex + 1).trim();
      store.set(key, value);
    },
    header() {
      if (!store.size) return "";
      return [...store.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
    }
  };
}

async function fetchJson(path, options = {}, cookieJar = null) {
  const headers = {
    ...(options.headers || {})
  };
  if (cookieJar?.header()) headers.Cookie = cookieJar.header();

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers
  });

  cookieJar?.setFromResponse(response);

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");

  return { response, body };
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return true;
    } catch {
      // server still booting
    }
    await delay(300);
  }
  throw new Error("server did not become healthy in time");
}

async function runCoreSmoke() {
  const cookieJar = createCookieJar();
  const suffix = `${Date.now()}`;
  const login = `smoke_${suffix}`;
  const password = "1234";

  {
    const { response, body } = await fetchJson("/health");
    assert(response.ok, "GET /health should return 200");
    assert(body?.status === "ok", "health payload should contain status=ok");
    mark("GET /health", "PASS");
  }

  {
    const { response, body } = await fetchJson("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password })
    }, cookieJar);
    assert(response.ok, "register should return 200");
    assert(body?.user?.login === login, "register should return created user");
    assert(cookieJar.header().includes("sf_session="), "register should establish session cookie");
    mark("signup", "PASS", login);
  }

  {
    const { response, body } = await fetchJson("/auth/me", {}, cookieJar);
    assert(response.ok, "GET /auth/me after register should return 200");
    assert(body?.user?.login === login, "auth/me should resolve current user");
    mark("GET /auth/me after signup", "PASS");
  }

  {
    const { response } = await fetchJson("/auth/logout", {
      method: "POST"
    }, cookieJar);
    assert(response.ok, "logout should return 200");
    mark("logout", "PASS");
  }

  {
    const { response } = await fetchJson("/auth/me", {}, cookieJar);
    assert(response.status === 401, "GET /auth/me after logout should return 401");
    mark("GET /auth/me after logout", "PASS");
  }

  {
    const { response, body } = await fetchJson("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password })
    }, cookieJar);
    assert(response.ok, "login should return 200");
    assert(body?.user?.login === login, "login should return current user");
    mark("login", "PASS");
  }

  {
    const { response, body } = await fetchJson("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "smoke/baseline.txt",
        content: `baseline-${suffix}`,
        create_dirs: true
      })
    }, cookieJar);
    assert(response.ok, "fs write should return 200");
    assert(body?.ok === true, "fs write should confirm ok");
    mark("criar arquivo na workspace", "PASS", body?.path || "smoke/baseline.txt");
  }

  {
    const { response, body } = await fetchJson("/api/fs/list?path=smoke", {}, cookieJar);
    assert(response.ok, "fs list should return 200");
    const items = Array.isArray(body?.items) ? body.items : [];
    assert(items.some((item) => item.path === "smoke/baseline.txt"), "fs list should include smoke file");
    mark("listar arquivos", "PASS");
  }

  {
    const promptId = `smoke-prompt-${suffix}`;
    const { response } = await fetchJson("/api/system-prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: promptId,
        name: `Smoke Prompt ${suffix}`,
        prompt: "Responder somente com OK."
      })
    }, cookieJar);
    assert(response.ok, "create system prompt should return 200");

    const listResult = await fetchJson("/api/system-prompts", {}, cookieJar);
    const items = Array.isArray(listResult.body?.items) ? listResult.body.items : [];
    assert(items.some((item) => item.id === promptId), "system prompt list should include created prompt");
    mark("criar prompt", "PASS", promptId);
  }

  {
    const { response, body } = await fetchJson("/auth/me", {}, cookieJar);
    assert(response.ok, "session should survive between authenticated requests");
    assert(body?.user?.login === login, "session should remain bound to same user");
    mark("sessao sobrevive entre requests", "PASS");
  }
}

async function pollChatJob(jobId, cookieJar, timeoutMs = 90000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await fetchJson(`/api/chat/jobs/${encodeURIComponent(jobId)}`, {}, cookieJar);
    const status = snapshot.body?.job?.status || "";
    if (status === "completed" || status === "failed") return snapshot.body;
    await delay(800);
  }
  throw new Error(`chat job ${jobId} timed out`);
}

async function runOptionalChatSmoke() {
  if (!ENABLE_CHAT_SMOKE) {
    mark("enviar mensagem no chat", "SKIP", "defina SMOKE_ENABLE_CHAT=1 para rodar o smoke externo");
    return;
  }

  if (!GEMINI_API_KEY) {
    mark("enviar mensagem no chat", "SKIP", "defina SMOKE_GEMINI_API_KEY ou GEMINI_API_KEY");
    return;
  }

  const cookieJar = createCookieJar();
  const suffix = `${Date.now()}`;
  const login = `smoke_chat_${suffix}`;
  const password = "1234";

  await fetchJson("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password })
  }, cookieJar);

  const createJob = await fetchJson("/api/chat/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "gemini",
      model: "gemini-2.5-flash-lite",
      api_key: GEMINI_API_KEY,
      request: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Responda apenas com OK." }]
          }
        ],
        generationConfig: {
          maxOutputTokens: 32
        }
      }
    })
  }, cookieJar);

  assert(createJob.response.status === 202, "chat job create should return 202");
  const jobId = createJob.body?.job?.id;
  assert(jobId, "chat job id is required");

  const snapshot = await pollChatJob(jobId, cookieJar);
  assert(snapshot?.job?.status === "completed", `chat job should complete, got ${snapshot?.job?.status || "unknown"}`);
  mark("enviar mensagem no chat", "PASS", jobId);
}

async function runOptionalTtsSmoke() {
  if (!ENABLE_TTS_SMOKE) {
    mark("rodar TTS", "SKIP", "defina SMOKE_ENABLE_TTS=1 para rodar o smoke externo");
    return;
  }

  if (!TTS_API || !TTS_SECRET) {
    mark("rodar TTS", "SKIP", "defina SMOKE_TTS_API e SMOKE_TTS_SECRET");
    return;
  }

  const healthResponse = await fetch(`${TTS_API}/health`);
  assert(healthResponse.ok, "TTS /health should return 200");

  const voicesResponse = await fetch(`${TTS_API}/vozes`, {
    headers: { "x-secret": TTS_SECRET }
  });
  assert(voicesResponse.ok, "TTS /vozes should return 200");
  mark("rodar TTS", "PASS", `${TTS_API}/health + /vozes`);
}

async function main() {
  let serverProcess = null;
  try {
    if (!USE_EXISTING_SERVER) {
      serverProcess = spawn("node", ["server.js"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });

      serverProcess.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) log(`[server] ${text}`);
      });

      serverProcess.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) log(`[server:err] ${text}`);
      });
    } else {
      log(`[info] usando servidor existente em ${BASE_URL}`);
    }

    await waitForHealth();
    await runCoreSmoke();
    await runOptionalChatSmoke();
    await runOptionalTtsSmoke();

    const failed = results.filter((item) => item.status === "FAIL");
    const skipped = results.filter((item) => item.status === "SKIP");
    log("");
    log(`Resumo: ${results.length} checks, ${failed.length} falhas, ${skipped.length} skips.`);
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    mark("smoke baseline", "FAIL", error.message);
    process.exitCode = 1;
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      await delay(300);
      if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    }
  }
}

await main();
