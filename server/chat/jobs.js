export function createChatJobsModule({
  randomBytes,
  join,
  mkdir,
  readFile,
  writeFile,
  existsSync,
  sanitizeId,
  ensureUserDirs,
  userChatJobsDir,
  getConfiguredGeminiApiKey,
  getConfiguredCodexAuth,
  defaultCodexReasoning,
  defaultCodexHistoryLimit,
  defaultCodexInstructions,
  chatJobStatusRunning,
  chatJobStatusCompleted,
  chatJobStatusFailed,
  geminiRunChatJob,
  codexRunChat,
  codexBuildContextMessages,
  sendJson,
  parseJsonBody
}) {
  const activeChatJobs = new Map();

  function generateChatJobId() {
    return `chat_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  }

  function chatJobPaths(user, jobId) {
    const safeId = sanitizeId(jobId);
    const dir = join(userChatJobsDir(user), safeId);
    return {
      id: safeId,
      dir,
      meta: join(dir, "meta.json"),
      stream: join(dir, "stream.sse"),
      result: join(dir, "result.json")
    };
  }

  async function writeChatJobMeta(user, jobId, meta) {
    const paths = chatJobPaths(user, jobId);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return meta;
  }

  async function readChatJobMeta(user, jobId) {
    const paths = chatJobPaths(user, jobId);
    try {
      const raw = await readFile(paths.meta, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const notFound = new Error("Chat job nao encontrado.");
        notFound.statusCode = 404;
        throw notFound;
      }
      throw error;
    }
  }

  async function readChatJobSnapshot(user, jobId) {
    const paths = chatJobPaths(user, jobId);
    const meta = await readChatJobMeta(user, jobId);
    const snapshot = { job: meta };

    if (meta.provider === "gemini" && existsSync(paths.stream)) {
      snapshot.raw_sse = await readFile(paths.stream, "utf8");
    }

    if (existsSync(paths.result)) {
      snapshot.result = JSON.parse(await readFile(paths.result, "utf8"));
    }

    return snapshot;
  }

  function normalizeChatJobPayload(input, credentials = {}) {
    const payload = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const provider = String(payload.provider || "").trim().toLowerCase();

    if (provider === "gemini") {
      const model = String(payload.model || "").trim();
      if (!model) {
        const error = new Error("model ausente.");
        error.statusCode = 400;
        throw error;
      }
      if (!payload.request || typeof payload.request !== "object" || Array.isArray(payload.request)) {
        const error = new Error("request invalido.");
        error.statusCode = 400;
        throw error;
      }
      return {
        provider,
        model,
        request: payload.request,
        api_key: String(payload.api_key || getConfiguredGeminiApiKey(credentials) || "").trim()
      };
    }

    if (provider === "codex") {
      const auth = payload.auth || getConfiguredCodexAuth(credentials);
      if (!auth) {
        const error = new Error("auth ausente.");
        error.statusCode = 400;
        throw error;
      }
      if (!payload.model) {
        const error = new Error("model ausente.");
        error.statusCode = 400;
        throw error;
      }
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        if (!Array.isArray(payload.input) || !payload.input.length) {
          const error = new Error("messages/input ausente.");
          error.statusCode = 400;
          throw error;
        }
      }
      if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
        const error = new Error("tools invalido.");
        error.statusCode = 400;
        throw error;
      }
      return {
        provider,
        auth,
        model: String(payload.model),
        reasoning: payload.reasoning || defaultCodexReasoning,
        history_limit: payload.history_limit ?? defaultCodexHistoryLimit,
        instructions: payload.instructions || defaultCodexInstructions,
        input: Array.isArray(payload.input) ? payload.input : null,
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        tools: payload.tools,
        session_id: payload.session_id
      };
    }

    const error = new Error("Unsupported provider for backend chat route");
    error.statusCode = 400;
    throw error;
  }

  async function runCodexChatJob(user, jobId, payload) {
    const paths = chatJobPaths(user, jobId);
    await mkdir(paths.dir, { recursive: true });
    const result = await codexRunChat({
      auth: payload.auth,
      model: payload.model,
      reasoning: payload.reasoning || defaultCodexReasoning,
      history_limit: payload.history_limit ?? defaultCodexHistoryLimit,
      instructions: payload.instructions || defaultCodexInstructions,
      input: payload.input,
      messages: payload.messages,
      tools: payload.tools,
      user,
      session_id: payload.session_id || `${user.id}-skillflow`
    });
    const contextItems = Array.isArray(payload.messages) && payload.messages.length
      ? await codexBuildContextMessages(payload.messages, payload.history_limit, user)
      : (Array.isArray(payload.input) ? payload.input : []);
    const snapshot = {
      ok: true,
      provider: "codex",
      model: payload.model,
      reasoning: payload.reasoning || defaultCodexReasoning,
      context_message_count: contextItems.length,
      payload: result.data
    };
    await writeFile(paths.result, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  async function finalizeChatJob(user, jobId, updater) {
    const previous = await readChatJobMeta(user, jobId);
    const next = {
      ...previous,
      ...updater,
      updated_at: new Date().toISOString()
    };
    if (next.status === chatJobStatusCompleted || next.status === chatJobStatusFailed) {
      next.finished_at = next.finished_at || new Date().toISOString();
    }
    await writeChatJobMeta(user, jobId, next);
    return next;
  }

  async function executeChatJob(user, jobId, payload) {
    activeChatJobs.set(jobId, { startedAt: Date.now(), provider: payload.provider });
    try {
      if (payload.provider === "gemini") {
        await geminiRunChatJob(user, jobId, payload, chatJobPaths);
      } else if (payload.provider === "codex") {
        await runCodexChatJob(user, jobId, payload);
      } else {
        const error = new Error("Unsupported provider for backend chat route");
        error.statusCode = 400;
        throw error;
      }

      await finalizeChatJob(user, jobId, {
        status: chatJobStatusCompleted,
        error: null
      });
    } catch (error) {
      await finalizeChatJob(user, jobId, {
        status: chatJobStatusFailed,
        error: {
          message: error.message,
          statusCode: error.statusCode || 500
        }
      });
    } finally {
      activeChatJobs.delete(jobId);
    }
  }

  async function createChatJob(user, input, credentialsLoader) {
    await ensureUserDirs(user);
    const credentials = await credentialsLoader(user);
    const payload = normalizeChatJobPayload(input, credentials);
    const jobId = generateChatJobId();
    // DEBUG: dump payload structure (no base64 content) to understand multimodal pipeline
    try {
      const inputItems = Array.isArray(payload.input) ? payload.input : [];
      const summary = inputItems.map((item, i) => {
        if (!item || typeof item !== "object") return `[${i}] ${typeof item}`;
        if (item.type === "function_call" || item.type === "function_call_output") {
          return `[${i}] ${item.type} name=${item.name || ""}`;
        }
        const parts = Array.isArray(item.content) ? item.content : [];
        const partInfo = parts.map((p) => {
          if (!p || typeof p !== "object") return String(typeof p);
          if (p.type === "input_image") {
            const url = String(p.image_url || "");
            const preview = url.startsWith("data:") ? `data:${url.split(";")[0].slice(5)};base64,<${url.length}ch>` : url.slice(0, 40);
            return `input_image(${preview})`;
          }
          if (p.type === "input_text" || p.type === "output_text") {
            const t = String(p.text || "");
            return `${p.type}(${t.length}ch: ${JSON.stringify(t.slice(0, 60))})`;
          }
          return p.type || "unknown";
        }).join(", ");
        return `[${i}] role=${item.role} content=[${partInfo}]`;
      });
      const msgCount = Array.isArray(payload.messages) ? payload.messages.length : 0;
      const msgWithImgs = Array.isArray(payload.messages)
        ? payload.messages.filter((m) => Array.isArray(m?.imgs) && m.imgs.length).length
        : 0;
      console.log(`[ChatJob:MULTIMODAL] ${jobId} provider=${payload.provider} model=${payload.model}`);
      console.log(`  messages[]: count=${msgCount} withImgs=${msgWithImgs}`);
      console.log(`  input[]: count=${inputItems.length}`);
      summary.forEach((s) => console.log(`    ${s}`));
    } catch (err) {
      console.warn(`[ChatJob:MULTIMODAL] dump failed: ${err.message}`);
    }
    const meta = {
      id: jobId,
      provider: payload.provider,
      model: payload.model,
      status: chatJobStatusRunning,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      finished_at: null,
      error: null
    };
    await writeChatJobMeta(user, jobId, meta);
    executeChatJob(user, jobId, payload).catch((error) => {
      console.error(`[ChatJob] ${jobId} falhou:`, error);
    });
    return meta;
  }

  async function handleChatJobsApi(req, res, url, user, credentialsLoader) {
    if (req.method === "POST" && url.pathname === "/api/chat/jobs") {
      const payload = await parseJsonBody(req);
      const job = await createChatJob(user, payload, credentialsLoader);
      sendJson(res, 202, { ok: true, job });
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/chat/jobs/")) {
      const jobId = sanitizeId(url.pathname.slice("/api/chat/jobs/".length));
      if (!jobId) {
        sendJson(res, 400, { error: "job id ausente." });
        return true;
      }
      const snapshot = await readChatJobSnapshot(user, jobId);
      sendJson(res, 200, { ok: true, ...snapshot, active: activeChatJobs.has(jobId) });
      return true;
    }

    return false;
  }

  return {
    handleChatJobsApi,
    normalizeChatJobPayload
  };
}
