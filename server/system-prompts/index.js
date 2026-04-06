export function createSystemPromptsModule({
  readFile,
  readdir,
  writeFile,
  unlink,
  existsSync,
  extname,
  join,
  sanitizeId,
  ensureBaseDirs,
  ensureUserDirs,
  userSystemPromptsDir,
  sharedSystemPromptsDir,
  systemPromptsDir,
  sharedSystemPromptFilePath,
  privateSystemPromptFilePath,
  legacySystemPromptFilePath,
  sendJson,
  parseJsonBody,
  requireApprovedAction
}) {
  function normalizeSystemPromptScope(inputScope, existingScope = "private") {
    const scope = String(inputScope || existingScope || "private").trim().toLowerCase();
    return scope === "shared" ? "shared" : "private";
  }

  function systemPromptStorageKey(scope, id) {
    return `${scope}:${sanitizeId(id)}`;
  }

  async function loadSystemPromptFromFile(filePath, scope, fallbackOwner = null) {
    const ext = extname(filePath).toLowerCase();
    let payload = null;
    if (ext === ".json") {
      payload = JSON.parse(await readFile(filePath, "utf8"));
    } else if (ext === ".txt" || ext === ".md") {
      const stem = filePath.split(/[/\\]/).pop().slice(0, -ext.length);
      payload = {
        id: sanitizeId(stem),
        name: stem.replace(/[_-]+/g, " ").trim() || stem,
        prompt: await readFile(filePath, "utf8")
      };
    }
    if (!payload?.id || !payload?.name || !payload?.prompt) return null;
    const normalizedScope = normalizeSystemPromptScope(payload.scope, scope);
    const ownerUserId = sanitizeId(payload.owner_user_id || payload.created_by_id || fallbackOwner?.id || "");
    const ownerLogin = String(payload.owner_login || payload.created_by || fallbackOwner?.login || "").trim();
    return {
      ...payload,
      id: sanitizeId(payload.id),
      name: String(payload.name || "").trim(),
      prompt: String(payload.prompt || "").trim(),
      scope: normalizedScope,
      owner_user_id: ownerUserId || undefined,
      owner_login: ownerLogin || undefined,
      storage_key: systemPromptStorageKey(normalizedScope, payload.id)
    };
  }

  async function readSystemPromptRecord(user, scope, id) {
    const normalizedId = sanitizeId(id);
    const normalizedScope = normalizeSystemPromptScope(scope);
    if (!normalizedId) return null;
    const filePath = normalizedScope === "shared"
      ? sharedSystemPromptFilePath(normalizedId)
      : privateSystemPromptFilePath(user, normalizedId);

    if (existsSync(filePath)) {
      const item = await loadSystemPromptFromFile(filePath, normalizedScope, normalizedScope === "private" ? user : null);
      if (item) return { item, filePath };
    }

    if (normalizedScope === "shared") {
      const legacyPath = legacySystemPromptFilePath(normalizedId);
      if (existsSync(legacyPath)) {
        const item = await loadSystemPromptFromFile(legacyPath, "shared");
        if (item) return { item, filePath: legacyPath };
      }
    }

    return null;
  }

  function assertSystemPromptPermission(user, existing) {
    if (!existing) return;
    if (existing.owner_user_id && existing.owner_user_id !== user.id) {
      const error = new Error("Sem permissao para modificar este system prompt");
      error.statusCode = 403;
      throw error;
    }
  }

  function normalizeSystemPromptPayload(input, user, existing = null) {
    if (!input || typeof input !== "object") {
      throw new Error("Invalid system prompt payload");
    }
    const scope = normalizeSystemPromptScope(input.scope, existing?.scope || "private");
    const name = String(input.name || input.id || "").trim();
    const prompt = String(input.prompt || input.content || "").trim();
    const id = sanitizeId(input.id || name);
    if (!id) throw new Error("System prompt id is required");
    if (!name) throw new Error("System prompt name is required");
    if (!prompt) throw new Error("System prompt content is required");

    const now = new Date().toISOString();
    return {
      id,
      name,
      prompt,
      scope,
      owner_user_id: existing?.owner_user_id || user.id,
      owner_login: existing?.owner_login || user.login,
      created_at: existing?.created_at || now,
      created_by: existing?.created_by || user.login,
      created_by_id: existing?.created_by_id || user.id,
      updated_at: now,
      updated_by: user.login,
      updated_by_id: user.id,
      storage_key: systemPromptStorageKey(scope, id)
    };
  }

  async function listSystemPrompts(user) {
    await ensureUserDirs(user);
    const items = [];
    const seen = new Set();
    const sources = [
      { dir: userSystemPromptsDir(user), scope: "private", fallbackOwner: user },
      { dir: sharedSystemPromptsDir, scope: "shared", fallbackOwner: null },
      { dir: systemPromptsDir, scope: "shared", fallbackOwner: null, legacyRoot: true }
    ];

    for (const source of sources) {
      const entries = await readdir(source.dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (source.legacyRoot && entry.name.startsWith("_")) continue;
        try {
          const item = await loadSystemPromptFromFile(join(source.dir, entry.name), source.scope, source.fallbackOwner);
          if (!item) continue;
          const dedupeKey = item.storage_key || systemPromptStorageKey(item.scope, item.id);
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          items.push(item);
        } catch (error) {
          console.error(`Failed to load system prompt ${entry.name}:`, error.message);
        }
      }
    }

    items.sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === "private" ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
    });
    return items;
  }

  async function handleSystemPromptsApi(req, res, url, user) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      res.end();
      return;
    }

    await ensureBaseDirs();

    if (req.method === "GET" && url.pathname === "/api/system-prompts") {
      sendJson(res, 200, { items: await listSystemPrompts(user) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/system-prompts") {
      const payload = await parseJsonBody(req);
      const scope = normalizeSystemPromptScope(payload.scope);
      const existingRecord = await readSystemPromptRecord(user, scope, payload.id || payload.name);
      const existing = existingRecord?.item || null;
      assertSystemPromptPermission(user, existing);
      const next = normalizeSystemPromptPayload(payload, user, existing);
      const filePath = scope === "shared"
        ? sharedSystemPromptFilePath(next.id)
        : privateSystemPromptFilePath(user, next.id);
      if (existingRecord?.filePath && existingRecord.filePath !== filePath && existsSync(existingRecord.filePath)) {
        await unlink(existingRecord.filePath).catch(() => {});
      }
      await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      sendJson(res, 200, { ok: true, item: next });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/system-prompts/")) {
      const ref = String(url.pathname.slice("/api/system-prompts/".length) || "");
      const [rawScope, rawId] = ref.includes("/") ? ref.split("/", 2) : ["private", ref];
      const scope = normalizeSystemPromptScope(rawScope);
      const id = sanitizeId(rawId);
      if (!id) {
        sendJson(res, 400, { error: "System prompt id is required" });
        return;
      }
      const existingRecord = await readSystemPromptRecord(user, scope, id);
      if (!existingRecord?.item || !existingRecord?.filePath) {
        sendJson(res, 404, { error: "System prompt not found" });
        return;
      }
      assertSystemPromptPermission(user, existingRecord.item);
      await requireApprovedAction(user, url.searchParams.get("approval_id"), "system_prompt_delete", {
        route: "/api/system-prompts/:scope/:id",
        id,
        scope
      }, {
        conversationId: url.searchParams.get("conversation_id")
      });
      await unlink(existingRecord.filePath);
      sendJson(res, 200, { ok: true, id, scope });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  }

  return {
    handleSystemPromptsApi,
    normalizeSystemPromptScope
  };
}
