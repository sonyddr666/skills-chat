export function createExecModule({
  spawn,
  randomBytes,
  readFile,
  writeFile,
  mkdir,
  readdir,
  existsSync,
  createWriteStream,
  join,
  ensureUserDirs,
  userRunsDir,
  fsNormalizeRelativePath,
  fsWorkspacePath,
  stateLoadUserState,
  stateSaveUserState,
  executionStateKey,
  maxExecHistoryItems,
  defaultExecTimeoutMs,
  maxExecTimeoutMs,
  maxExecLogTailBytes,
  execEnabled,
  execAllowAllBins,
  execAllowedBins,
  execAllowShell,
  processEnv,
  sendJson,
  parseJsonBody,
  parseOptionalBoolean,
  requireApprovedAction,
  normalizeConversationId,
  inferExecProfile,
  execProfilePolicy
}) {
  const activeExecutions = new Map();

  function executionDir(user, runId) {
    return join(userRunsDir(user), runId);
  }

  function executionPaths(user, runId) {
    const dir = executionDir(user, runId);
    return {
      dir,
      request: join(dir, "request.json"),
      result: join(dir, "result.json"),
      stdout: join(dir, "stdout.log"),
      stderr: join(dir, "stderr.log")
    };
  }

  function executionRelativePath(runId, fileName) {
    return fsNormalizeRelativePath(join(".runs", runId, fileName));
  }

  function generateRunId() {
    return `exec_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  }

  function normalizeRunId(input) {
    const value = String(input || "").trim().toLowerCase();
    return /^[a-z0-9_-]{6,120}$/.test(value) ? value : "";
  }

  function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function clampExecTimeoutMs(value) {
    return clampInteger(value, defaultExecTimeoutMs, 1000, maxExecTimeoutMs);
  }

  function clampExecHistoryLimit(value) {
    return clampInteger(value, 20, 1, maxExecHistoryItems);
  }

  function clampExecLogTailBytes(value) {
    return clampInteger(value, 16 * 1024, 512, maxExecLogTailBytes);
  }

  function normalizeExecEnv(input) {
    if (input === undefined || input === null) return {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("env precisa ser um objeto simples");
    }

    const env = {};
    for (const [key, value] of Object.entries(input)) {
      const name = String(key || "").trim();
      if (!name) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`env invalido: ${name}`);
      }
      env[name] = String(value ?? "");
    }
    return env;
  }

  function normalizeExecPayload(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Payload de execucao invalido");
    }

    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) {
      throw new Error("command is required");
    }

    const args = Array.isArray(input.args) ? input.args.map((value) => String(value)) : [];
    const shell = parseOptionalBoolean(input.shell, !Array.isArray(input.args));
    if (shell && args.length) {
      throw new Error("Use command completo com shell=true ou defina shell=false para enviar args");
    }

    return {
      title: String(input.title || command).trim().slice(0, 160) || command,
      command,
      args,
      shell,
      cwd: fsNormalizeRelativePath(input.cwd || ""),
      env: normalizeExecEnv(input.env),
      stdin: input.stdin === undefined || input.stdin === null ? "" : String(input.stdin),
      timeoutMs: clampExecTimeoutMs(input.timeout_ms)
    };
  }

  function normalizeExecCommandName(command) {
    const raw = String(command || "").trim();
    if (!raw) return "";
    const match = raw.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/);
    const token = (match ? match[1] : raw)
      .replace(/^['"]|['"]$/g, "");
    const leaf = token.split(/[\\/]/).at(-1) || token;
    return leaf.replace(/\.exe$/i, "").toLowerCase();
  }

  function validateExecPolicy(payload) {
    const commandName = normalizeExecCommandName(payload.command);
    const profile = inferExecProfile(payload);
    const profilePolicy = execProfilePolicy(profile);
    if (!commandName) {
      const error = new Error("command is required");
      error.statusCode = 400;
      throw error;
    }

    if (!execAllowAllBins && !execAllowedBins.has(commandName)) {
      const error = new Error(`Comando bloqueado por politica: ${commandName}`);
      error.statusCode = 403;
      throw error;
    }

    if (payload.shell && !execAllowShell) {
      const error = new Error("Execucao com shell=true esta desabilitada por politica");
      error.statusCode = 403;
      throw error;
    }

    if (payload.shell && !profilePolicy.allowShell) {
      const error = new Error("Perfil de execucao nao permite shell=true");
      error.statusCode = 403;
      throw error;
    }

    if (payload.timeoutMs > profilePolicy.maxTimeoutMs) {
      const error = new Error(`timeout_ms excede o perfil ${profile}`);
      error.statusCode = 403;
      throw error;
    }

    if (Object.keys(payload.env || {}).length > profilePolicy.maxEnvKeys) {
      const error = new Error(`env excede o limite do perfil ${profile}`);
      error.statusCode = 403;
      throw error;
    }

    if (Buffer.byteLength(payload.stdin || "", "utf8") > 64 * 1024) {
      const error = new Error("stdin excede o limite de 64KB");
      error.statusCode = 403;
      throw error;
    }

    if ((payload.cwd || "").startsWith(".runs") || (payload.cwd || "").startsWith(".chat-jobs")) {
      const error = new Error("cwd bloqueado por politica");
      error.statusCode = 403;
      throw error;
    }

    if (payload.shell) {
      const blockedPatterns = [
        /\brm\s+-rf\b/i,
        /\bmkfs\b/i,
        /\bdd\s+if=/i,
        /\bcurl\b.*\|\s*(?:sh|bash)\b/i,
        /\bwget\b.*\|\s*(?:sh|bash)\b/i,
        />\s*\/etc\//i
      ];
      for (const pattern of blockedPatterns) {
        if (pattern.test(payload.command)) {
          const error = new Error("Comando shell bloqueado por politica");
          error.statusCode = 403;
          throw error;
        }
      }
    }

    return {
      commandName,
      profile,
      profilePolicy
    };
  }

  function buildExecutionRequestSnapshot(payload, cwd) {
    return {
      title: payload.title,
      command: payload.command,
      args: payload.args,
      shell: payload.shell,
      cwd: cwd || ".",
      conversation_id: payload.conversationId || null,
      timeout_ms: payload.timeoutMs,
      stdin_bytes: Buffer.byteLength(payload.stdin || "", "utf8"),
      env_keys: Object.keys(payload.env),
      approval_id: payload.approvalId || null,
      profile: payload.profile || inferExecProfile(payload)
    };
  }

  function buildExecutionMeta(payload, runId, cwd) {
    return {
      id: runId,
      title: payload.title,
      status: "running",
      command: payload.command,
      args: payload.args,
      shell: payload.shell,
      cwd: cwd || ".",
      conversation_id: payload.conversationId || null,
      timeout_ms: payload.timeoutMs,
      env_keys: Object.keys(payload.env),
      profile: payload.profile || inferExecProfile(payload),
      approval_id: payload.approvalId || null,
      request_path: executionRelativePath(runId, "request.json"),
      result_path: executionRelativePath(runId, "result.json"),
      stdout_path: executionRelativePath(runId, "stdout.log"),
      stderr_path: executionRelativePath(runId, "stderr.log"),
      pid: null,
      exit_code: null,
      signal: null,
      error: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      duration_ms: null,
      audit: []
    };
  }

  function buildExecutionSummary(meta) {
    return {
      id: meta.id,
      title: meta.title,
      status: meta.status,
      command: meta.command,
      profile: meta.profile,
      cwd: meta.cwd,
      started_at: meta.started_at,
      finished_at: meta.finished_at,
      duration_ms: meta.duration_ms,
      exit_code: meta.exit_code,
      signal: meta.signal,
      pid: meta.pid
    };
  }

  async function persistExecutionSummary(user, summary) {
    const state = await stateLoadUserState(user);
    const current = state[executionStateKey] && typeof state[executionStateKey] === "object"
      ? state[executionStateKey]
      : {};
    const recent = Array.isArray(current.recent)
      ? current.recent.filter((item) => item && item.id !== summary.id)
      : [];

    recent.unshift(summary);
    state[executionStateKey] = {
      last_run_id: summary.id,
      updated_at: new Date().toISOString(),
      recent: recent.slice(0, maxExecHistoryItems)
    };
    await stateSaveUserState(user, state);
  }

  async function persistExecutionMeta(user, meta) {
    const paths = executionPaths(user, meta.id);
    await writeFile(paths.result, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await persistExecutionSummary(user, buildExecutionSummary(meta));
  }

  async function readExecutionMeta(user, runId) {
    const paths = executionPaths(user, runId);
    if (!existsSync(paths.result)) return null;
    return JSON.parse(await readFile(paths.result, "utf8"));
  }

  function getActiveExecution(user, runId) {
    const active = activeExecutions.get(runId);
    if (!active || active.userId !== user.id) return null;
    return active;
  }

  async function getExecutionMeta(user, runId) {
    const active = getActiveExecution(user, runId);
    if (active) return active.meta;
    return readExecutionMeta(user, runId);
  }

  function closeWriteStream(stream) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stream.once("finish", finish);
      stream.once("error", finish);
      stream.end();
    });
  }

  async function readExecutionLog(logPath, tailBytes) {
    if (!existsSync(logPath)) {
      return { content: "", size: 0, truncated: false };
    }
    const buffer = await readFile(logPath);
    const limit = clampExecLogTailBytes(tailBytes);
    const truncated = buffer.length > limit;
    const sliced = truncated ? buffer.subarray(buffer.length - limit) : buffer;
    return {
      content: sliced.toString("utf8"),
      size: buffer.length,
      truncated
    };
  }

  async function listExecutionHistory(user, limit) {
    await ensureUserDirs(user);
    const entries = await readdir(userRunsDir(user), { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = normalizeRunId(entry.name);
      if (!runId) continue;
      try {
        const meta = await readExecutionMeta(user, runId);
        if (!meta) continue;
        items.push(buildExecutionSummary(meta));
      } catch (error) {
        console.error(`Failed to load execution ${entry.name}:`, error.message);
      }
    }

    items.sort((a, b) => {
      const left = Date.parse(b.finished_at || b.started_at || 0);
      const right = Date.parse(a.finished_at || a.started_at || 0);
      return left - right;
    });

    return items.slice(0, clampExecHistoryLimit(limit));
  }

  async function createExecution(user, input) {
    const payload = normalizeExecPayload(input);
    const policy = validateExecPolicy(payload);
    const workdir = fsWorkspacePath(user, payload.cwd);
    const approval = await requireApprovedAction(
      user,
      input?.approval_id,
      "exec",
      {
        route: "/api/exec",
        command: payload.command,
        cwd: workdir.rel || ".",
        profile: policy.profile
      },
      {
        conversationId: input?.conversation_id
      }
    );
    const runId = generateRunId();
    const paths = executionPaths(user, runId);

    const execPayload = {
      ...payload,
      approvalId: approval.id,
      profile: policy.profile,
      conversationId: normalizeConversationId(input?.conversation_id)
    };

    await mkdir(paths.dir, { recursive: true });
    await writeFile(
      paths.request,
      `${JSON.stringify(buildExecutionRequestSnapshot(execPayload, workdir.rel || "."), null, 2)}\n`,
      "utf8"
    );

    let meta = buildExecutionMeta(execPayload, runId, workdir.rel || ".");
    meta.audit = [
      {
        at: meta.started_at,
        actor_user_id: user.id,
        actor_login: user.login,
        event: "created",
        approval_id: approval.id,
        profile: policy.profile
      }
    ];
    await persistExecutionMeta(user, meta);

    const stdoutStream = createWriteStream(paths.stdout, { flags: "a" });
    const stderrStream = createWriteStream(paths.stderr, { flags: "a" });

    const child = payload.shell
      ? spawn(payload.command, {
        cwd: workdir.absolute,
        env: { ...processEnv, ...payload.env },
        shell: true,
        stdio: "pipe"
      })
      : spawn(payload.command, payload.args, {
        cwd: workdir.absolute,
        env: { ...processEnv, ...payload.env },
        shell: false,
        stdio: "pipe"
      });

    meta = {
      ...meta,
      pid: child.pid ?? null
    };

    const active = {
      userId: user.id,
      child,
      meta,
      stdoutStream,
      stderrStream,
      timeoutHandle: null,
      forceKillHandle: null,
      statusOverride: null,
      finalized: false
    };
    activeExecutions.set(runId, active);

    const finalize = async ({ status, exitCode, signal, errorMessage = null }) => {
      if (active.finalized) return;
      active.finalized = true;
      activeExecutions.delete(runId);
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
      if (active.forceKillHandle) clearTimeout(active.forceKillHandle);

      await Promise.all([
        closeWriteStream(stdoutStream),
        closeWriteStream(stderrStream)
      ]);

      const finishedAt = new Date().toISOString();
      const startedAt = Date.parse(active.meta.started_at);
      active.meta = {
        ...active.meta,
        status,
        exit_code: typeof exitCode === "number" ? exitCode : null,
        signal: signal || null,
        error: errorMessage,
        finished_at: finishedAt,
        duration_ms: Number.isFinite(startedAt)
          ? Math.max(0, Date.parse(finishedAt) - startedAt)
          : null
      };

      await persistExecutionMeta(user, active.meta);
    };

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutStream.write(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrStream.write(chunk);
      });
    }

    child.on("error", (error) => {
      void finalize({
        status: active.statusOverride || "failed",
        exitCode: null,
        signal: null,
        errorMessage: error.message
      });
    });

    child.on("close", (code, signal) => {
      void finalize({
        status: active.statusOverride || (code === 0 ? "completed" : "failed"),
        exitCode: code,
        signal
      });
    });

    if (child.stdin) {
      try {
        if (payload.stdin) child.stdin.write(payload.stdin);
        child.stdin.end();
      } catch {
        child.stdin.destroy();
      }
    }

    active.timeoutHandle = setTimeout(() => {
      if (active.finalized) return;
      active.statusOverride = "timed_out";
      child.kill("SIGTERM");
      active.forceKillHandle = setTimeout(() => {
        if (!active.finalized) child.kill("SIGKILL");
      }, 5000);
    }, payload.timeoutMs);

    return meta;
  }

  async function cancelExecution(user, runId) {
    const active = getActiveExecution(user, runId);
    if (!active) return null;
    active.statusOverride = "cancelled";
    const signaled = active.child.kill("SIGTERM");
    active.forceKillHandle = setTimeout(() => {
      if (!active.finalized) active.child.kill("SIGKILL");
    }, 5000);
    return {
      ok: signaled,
      run: active.meta
    };
  }

  async function handleExecApi(req, res, url, user) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/api/exec" || url.pathname === "/api/exec/history")) {
      sendJson(res, 200, {
        items: await listExecutionHistory(user, url.searchParams.get("limit"))
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/exec") {
      if (!execEnabled) {
        console.warn(`[ExecPolicy] Bloqueado por politica para usuario ${user.id}. Defina SKILLFLOW_EXEC_ENABLED=true para liberar /api/exec.`);
        sendJson(res, 403, { error: "Execucao desabilitada por politica do servidor" });
        return;
      }
      const payload = await parseJsonBody(req);
      const run = await createExecution(user, payload);
      sendJson(res, 202, { ok: true, run });
      return;
    }

    if (!url.pathname.startsWith("/api/exec/")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const parts = url.pathname.slice("/api/exec/".length).split("/").filter(Boolean);
    const runId = normalizeRunId(parts[0]);
    if (!runId) {
      sendJson(res, 400, { error: "Invalid execution id" });
      return;
    }

    if (parts.length === 1 && req.method === "GET") {
      const run = await getExecutionMeta(user, runId);
      if (!run) {
        sendJson(res, 404, { error: "Execution not found" });
        return;
      }
      sendJson(res, 200, {
        run,
        active: Boolean(getActiveExecution(user, runId))
      });
      return;
    }

    if (parts.length === 2 && parts[1] === "logs" && req.method === "GET") {
      const run = await getExecutionMeta(user, runId);
      if (!run) {
        sendJson(res, 404, { error: "Execution not found" });
        return;
      }

      const stream = String(url.searchParams.get("stream") || "both").trim().toLowerCase();
      if (!["stdout", "stderr", "both"].includes(stream)) {
        sendJson(res, 400, { error: "stream must be stdout, stderr or both" });
        return;
      }

      const tailBytes = url.searchParams.get("tail_bytes");
      const paths = executionPaths(user, runId);

      if (stream === "stdout") {
        sendJson(res, 200, {
          id: runId,
          active: Boolean(getActiveExecution(user, runId)),
          stream,
          ...(await readExecutionLog(paths.stdout, tailBytes))
        });
        return;
      }

      if (stream === "stderr") {
        sendJson(res, 200, {
          id: runId,
          active: Boolean(getActiveExecution(user, runId)),
          stream,
          ...(await readExecutionLog(paths.stderr, tailBytes))
        });
        return;
      }

      sendJson(res, 200, {
        id: runId,
        active: Boolean(getActiveExecution(user, runId)),
        stream,
        stdout: await readExecutionLog(paths.stdout, tailBytes),
        stderr: await readExecutionLog(paths.stderr, tailBytes)
      });
      return;
    }

    if (parts.length === 2 && parts[1] === "cancel" && req.method === "POST") {
      const existing = await getExecutionMeta(user, runId);
      if (!existing) {
        sendJson(res, 404, { error: "Execution not found" });
        return;
      }

      const result = await cancelExecution(user, runId);
      if (!result) {
        sendJson(res, 409, { error: "Execution is not active", run: existing });
        return;
      }

      sendJson(res, 202, result);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  }

  return {
    handleExecApi
  };
}
