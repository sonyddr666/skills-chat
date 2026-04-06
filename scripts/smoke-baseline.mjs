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
const ENABLE_EXEC_APPROVAL_SMOKE = ["1", "true", "yes", "on"].includes(String(process.env.SMOKE_ENABLE_EXEC_APPROVAL || "").trim().toLowerCase());
const EXEC_ENABLED_FOR_SMOKE = ["1", "true", "yes", "on"].includes(String(process.env.SKILLFLOW_EXEC_ENABLED || "").trim().toLowerCase());

const results = [];
let serverProcess = null;

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

async function fetchJsonExpectingAnyStatus(path, options = {}, cookieJar = null) {
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

function attachServerLogs(child) {
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) log(`[server] ${text}`);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) log(`[server:err] ${text}`);
  });
}

function spawnServer() {
  const child = spawn("node", ["server.js"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  attachServerLogs(child);
  return child;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await delay(300);
  if (!child.killed) child.kill("SIGKILL");
}

async function restartServer() {
  if (USE_EXISTING_SERVER) return false;
  await stopServer(serverProcess);
  serverProcess = spawnServer();
  await waitForHealth();
  return true;
}

async function registerUser(login, password, cookieJar) {
  const { response, body } = await fetchJson("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password })
  }, cookieJar);
  assert(response.ok, "register should return 200");
  assert(body?.user?.login === login, "register should return created user");
  assert(cookieJar.header().includes("sf_session="), "register should establish session cookie");
}

async function createApproval(cookieJar, payload) {
  const { response, body } = await fetchJson("/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, cookieJar);
  assert(response.status === 201, "approval create should return 201");
  assert(body?.item?.id, "approval id is required");
  return body.item;
}

async function approveApproval(cookieJar, approvalId) {
  const { response, body } = await fetchJson(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
    method: "POST"
  }, cookieJar);
  assert(response.ok, "approval approve should return 200");
  assert(body?.item?.status === "approved", "approval should move to approved");
  return body.item;
}

async function runCoreSmoke() {
  const cookieJar = createCookieJar();
  const secondaryCookieJar = createCookieJar();
  const suffix = `${Date.now()}`;
  const login = `smoke_${suffix}`;
  const secondaryLogin = `smoke_peer_${suffix}`;
  const password = "1234";

  {
    const { response, body } = await fetchJson("/health");
    assert(response.ok, "GET /health should return 200");
    assert(body?.status === "ok", "health payload should contain status=ok");
    mark("GET /health", "PASS");
  }

  {
    await registerUser(login, password, cookieJar);
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
    await registerUser(secondaryLogin, password, secondaryCookieJar);
    const listResult = await fetchJson("/api/system-prompts", {}, secondaryCookieJar);
    const items = Array.isArray(listResult.body?.items) ? listResult.body.items : [];
    assert(!items.some((item) => item.id === `smoke-prompt-${suffix}` && item.scope !== "shared"), "private prompt should not leak to another user");
    mark("prompt privado isolado por usuario", "PASS");
  }

  {
    const sharedPromptId = `smoke-shared-${suffix}`;
    const sharedCreate = await fetchJson("/api/system-prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: sharedPromptId,
        name: `Smoke Shared ${suffix}`,
        prompt: "Prompt compartilhado de smoke.",
        scope: "shared"
      })
    }, cookieJar);
    assert(sharedCreate.response.ok, "shared prompt create should return 200");
    const secondaryList = await fetchJson("/api/system-prompts", {}, secondaryCookieJar);
    const items = Array.isArray(secondaryList.body?.items) ? secondaryList.body.items : [];
    assert(items.some((item) => item.id === sharedPromptId && item.scope === "shared"), "shared prompt should be visible to another user");
    mark("prompt compartilhado visivel por decisao explicita", "PASS");
  }

  {
    const { response, body } = await fetchJson("/auth/me", {}, cookieJar);
    assert(response.ok, "session should survive between authenticated requests");
    assert(body?.user?.login === login, "session should remain bound to same user");
    mark("sessao sobrevive entre requests", "PASS");
  }

  if (!USE_EXISTING_SERVER) {
    await restartServer();
    const { response, body } = await fetchJson("/auth/me", {}, cookieJar);
    assert(response.ok, "session should survive server restart");
    assert(body?.user?.login === login, "session should remain valid after restart");
    mark("sessao persiste apos restart", "PASS");
  } else {
    mark("sessao persiste apos restart", "SKIP", "use smoke sem SMOKE_USE_EXISTING_SERVER para validar restart");
  }

  {
    const { response, body } = await fetchJsonExpectingAnyStatus("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "node",
        args: ["--version"]
      })
    }, cookieJar);
    assert(response.status === 403, "exec without approval/policy should return 403");
    if (EXEC_ENABLED_FOR_SMOKE) {
      assert(String(body?.error || "").includes("approval"), "exec enabled should require approval");
      mark("POST /api/exec exige approval quando habilitado", "PASS");
    } else {
      assert(body?.error === "Execucao desabilitada por politica do servidor", "exec policy error should be explicit");
      mark("POST /api/exec desabilitado por padrao", "PASS");
    }
  }

  {
    const pendingApproval = await createApproval(cookieJar, {
      action: "fs_delete",
      reason: "Smoke delete approval",
      payload: { path: "smoke/delete-with-approval.txt" }
    });
    const approvalDetails = await fetchJson(`/api/approvals/${encodeURIComponent(pendingApproval.id)}`, {}, cookieJar);
    assert(approvalDetails.response.ok, "approval get should return 200");
    assert(approvalDetails.body?.item?.status === "pending", "approval should start pending");
    await approveApproval(cookieJar, pendingApproval.id);
    mark("approval lifecycle basico", "PASS", pendingApproval.id);
  }

  {
    await fetchJson("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "smoke/delete-no-approval.txt",
        content: `delete-no-approval-${suffix}`,
        create_dirs: true
      })
    }, cookieJar);
    const { response, body } = await fetchJsonExpectingAnyStatus("/api/fs/delete?path=smoke%2Fdelete-no-approval.txt", {
      method: "DELETE"
    }, cookieJar);
    assert(response.status === 403, "delete without approval should return 403");
    assert(String(body?.error || "").includes("approval"), "delete without approval should mention approval");
    mark("delete sem approval bloqueado", "PASS");
  }

  {
    await fetchJson("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "smoke/delete-with-approval.txt",
        content: `delete-with-approval-${suffix}`,
        create_dirs: true
      })
    }, cookieJar);
    const approval = await createApproval(cookieJar, {
      action: "fs_delete",
      reason: "Smoke delete with approval",
      payload: { path: "smoke/delete-with-approval.txt" }
    });
    await approveApproval(cookieJar, approval.id);
    const deleted = await fetchJson(`/api/fs/delete?path=smoke%2Fdelete-with-approval.txt&approval_id=${encodeURIComponent(approval.id)}`, {
      method: "DELETE"
    }, cookieJar);
    assert(deleted.response.ok, "delete with approval should return 200");
    mark("delete com approval aprovado", "PASS");
  }

  {
    const { response, body } = await fetchJsonExpectingAnyStatus("/api/ghost-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "smoke test" })
    }, cookieJar);
    assert(response.status === 403, "ghost-search without approval should return 403");
    assert(String(body?.error || "").includes("approval"), "ghost-search without approval should mention approval");
    mark("integracao externa sem approval bloqueada", "PASS");
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

async function runOptionalExecApprovalSmoke() {
  if (!ENABLE_EXEC_APPROVAL_SMOKE) {
    mark("exec com approval server-side", "SKIP", "defina SMOKE_ENABLE_EXEC_APPROVAL=1 para rodar com exec habilitado");
    return;
  }

  const cookieJar = createCookieJar();
  const suffix = `${Date.now()}`;
  const login = `smoke_exec_${suffix}`;
  const password = "1234";
  await registerUser(login, password, cookieJar);

  const approval = await createApproval(cookieJar, {
    action: "exec",
    reason: "Smoke exec approval",
    payload: {
      command: "node",
      args: ["--version"],
      cwd: ""
    }
  });
  await approveApproval(cookieJar, approval.id);

  const created = await fetchJson("/api/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "node",
      args: ["--version"],
      approval_id: approval.id
    })
  }, cookieJar);
  assert(created.response.status === 202, "exec with approval should queue");
  const runId = created.body?.run?.id;
  assert(runId, "exec run id is required");

  const startedAt = Date.now();
  let run = null;
  while (Date.now() - startedAt < 30000) {
    const status = await fetchJson(`/api/exec/${encodeURIComponent(runId)}`, {}, cookieJar);
    run = status.body?.run || null;
    if (run?.status && run.status !== "running") break;
    await delay(400);
  }

  assert(run?.status === "completed", `exec run should complete, got ${run?.status || "unknown"}`);
  mark("exec com approval server-side", "PASS", runId);
}

async function main() {
  try {
    if (!USE_EXISTING_SERVER) {
      serverProcess = spawnServer();
    } else {
      log(`[info] usando servidor existente em ${BASE_URL}`);
    }

    await waitForHealth();
    await runCoreSmoke();
    await runOptionalChatSmoke();
    await runOptionalTtsSmoke();
    await runOptionalExecApprovalSmoke();

    const failed = results.filter((item) => item.status === "FAIL");
    const skipped = results.filter((item) => item.status === "SKIP");
    log("");
    log(`Resumo: ${results.length} checks, ${failed.length} falhas, ${skipped.length} skips.`);
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    mark("smoke baseline", "FAIL", error.message);
    process.exitCode = 1;
  } finally {
    await stopServer(serverProcess);
  }
}

await main();
