export function createCodexModule({
  fetch,
  URLSearchParams,
  Buffer,
  readWorkspaceFile,
  tokenUrl,
  codexResponsesUrl,
  openAiOauthClientId,
  defaultCodexHistoryLimit,
  defaultCodexModel,
  codexFakeResponses,
  nowMs
}) {
  function clampCodexHistoryLimit(value) {
    const parsed = Number.parseInt(String(value ?? defaultCodexHistoryLimit), 10);
    if (Number.isNaN(parsed)) return defaultCodexHistoryLimit;
    return Math.max(2, Math.min(200, parsed));
  }

  function decodeBase64Url(value) {
    const normalized = String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const pad = normalized.length % 4;
    const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
    return Buffer.from(padded, "base64").toString("utf8");
  }

  function decodeJwtPayload(token) {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    try {
      return JSON.parse(decodeBase64Url(parts[1]));
    } catch {
      return null;
    }
  }

  function extractCodexAccountId(token) {
    const payload = decodeJwtPayload(token);
    if (!payload || typeof payload !== "object") return null;
    const auth = payload["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return null;
    return auth.chatgpt_account_id || null;
  }

  function parseCodexErrorPayload(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function isCodexDeactivatedWorkspaceError(raw) {
    const payload = parseCodexErrorPayload(raw);
    if (!payload || typeof payload !== "object") return false;
    const code = payload.detail?.code || payload.error?.code || payload.code || null;
    return String(code || "").trim() === "deactivated_workspace";
  }

  function normalizeCodexAuth(input) {
    let auth = input;
    if (typeof auth === "string") {
      const trimmed = auth.trim();
      if (!trimmed) throw new Error("auth invalido: vazio.");
      auth = trimmed.startsWith("{") ? JSON.parse(trimmed) : { access: trimmed };
    }

    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      throw new Error("auth invalido: esperado objeto JSON.");
    }

    const access = auth.access || auth.access_token;
    const refresh = auth.refresh || auth.refresh_token || null;
    let expires = auth.expires ?? auth.expires_at ?? null;

    if (expires !== null && expires !== undefined && expires !== "") {
      const parsed = Number.parseInt(String(expires), 10);
      if (Number.isNaN(parsed)) {
        expires = null;
      } else {
        expires = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
      }
    } else {
      expires = null;
    }

    if (!access) {
      throw new Error("auth invalido: access/access_token ausente.");
    }

    const explicitAccountId = typeof auth.accountId === "string" && auth.accountId.trim()
      ? auth.accountId.trim()
      : (typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id.trim()
        ? auth.chatgpt_account_id.trim()
        : null);
    const derivedAccountId = explicitAccountId ? null : extractCodexAccountId(access);

    return {
      access,
      refresh,
      expires,
      accountId: explicitAccountId || derivedAccountId,
      accountIdSource: explicitAccountId ? "provided" : (derivedAccountId ? "token" : null)
    };
  }

  async function refreshCodexAuth(auth) {
    if (!auth.refresh) return auth;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: openAiOauthClientId
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(raw || `refresh falhou: HTTP ${response.status}`);
    }

    const payload = raw ? JSON.parse(raw) : {};
    const explicitAccountId = auth.accountIdSource === "provided" && typeof auth.accountId === "string" && auth.accountId.trim()
      ? auth.accountId.trim()
      : null;
    const derivedAccountId = explicitAccountId ? null : extractCodexAccountId(payload.access_token);
    return {
      access: payload.access_token,
      refresh: payload.refresh_token || auth.refresh,
      expires: nowMs() + Number(payload.expires_in || 0) * 1000,
      accountId: explicitAccountId || derivedAccountId,
      accountIdSource: explicitAccountId ? "provided" : (derivedAccountId ? "token" : null)
    };
  }

  async function getValidCodexAuth(input) {
    const auth = normalizeCodexAuth(input);
    if (auth.refresh && auth.expires && auth.expires <= nowMs() + 300000) {
      return refreshCodexAuth(auth);
    }
    return auth;
  }

  function collectSseChunks(value, keyName, chunks) {
    if (Array.isArray(value)) {
      for (const item of value) collectSseChunks(item, keyName, chunks);
      return;
    }

    if (!value || typeof value !== "object") return;

    for (const nested of Object.values(value)) {
      collectSseChunks(nested, keyName, chunks);
    }

    if (typeof value[keyName] === "string") {
      chunks.push(value[keyName]);
    }
  }

  function extractCodexResponseOutputText(responseObj) {
    const chunks = [];
    if (!responseObj || typeof responseObj !== "object") return chunks;
    const output = Array.isArray(responseObj.output) ? responseObj.output : [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (part && typeof part.text === "string") chunks.push(part.text);
      }
    }
    return chunks;
  }

  function normalizeCodexFunctionCallItem(item) {
    if (!item || typeof item !== "object") return null;
    if (item.type !== "function_call") return null;

    const name = typeof item.name === "string" ? item.name.trim() : "";
    const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
    const rawArguments = typeof item.arguments === "string"
      ? item.arguments
      : JSON.stringify(item.arguments ?? {});

    if (!name || !callId) return null;

    let parsedArguments = {};
    if (rawArguments.trim()) {
      try {
        const parsed = JSON.parse(rawArguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedArguments = parsed;
        }
      } catch {
        parsedArguments = {};
      }
    }

    return {
      type: "function_call",
      id: typeof item.id === "string" ? item.id : callId,
      call_id: callId,
      name,
      arguments: rawArguments,
      parsed_arguments: parsedArguments
    };
  }

  function extractCodexResponseFunctionCalls(responseObj) {
    const calls = [];
    if (!responseObj || typeof responseObj !== "object") return calls;
    const output = Array.isArray(responseObj.output) ? responseObj.output : [];
    for (const item of output) {
      const normalized = normalizeCodexFunctionCallItem(item);
      if (normalized) calls.push(normalized);
    }
    return calls;
  }

  function parseCodexSsePayload(raw) {
    const events = [];
    for (const line of String(raw || "").split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === "[DONE]") continue;
      try {
        events.push(JSON.parse(chunk));
      } catch {
        // Ignore malformed SSE chunks.
      }
    }

    let responseId = null;
    const deltaParts = [];
    let finalTextParts = [];
    let finalResponse = null;
    const streamedToolCalls = new Map();

    for (const event of events) {
      if (!responseId && event && typeof event === "object") {
        responseId = event.response_id || event.id || null;
      }

      const deltas = [];
      collectSseChunks(event, "delta", deltas);
      for (const delta of deltas) {
        if (typeof delta === "string") deltaParts.push(delta);
      }

      if (event?.type === "response.output_item.added") {
        const normalized = normalizeCodexFunctionCallItem(event.item);
        if (normalized) {
          const key = Number.isInteger(event.output_index) ? event.output_index : streamedToolCalls.size;
          streamedToolCalls.set(key, normalized);
        }
      }

      if (event?.type === "response.function_call_arguments.delta" && Number.isInteger(event.output_index)) {
        const current = streamedToolCalls.get(event.output_index);
        if (current) {
          current.arguments += typeof event.delta === "string" ? event.delta : "";
        }
      }

      if (event?.type === "response.function_call_arguments.done") {
        const normalized = normalizeCodexFunctionCallItem(event.item);
        if (normalized) {
          const key = Number.isInteger(event.output_index) ? event.output_index : streamedToolCalls.size;
          streamedToolCalls.set(key, normalized);
        }
      }

      if (event?.type === "response.completed") {
        finalResponse = event.response && typeof event.response === "object" ? event.response : null;
        finalTextParts = extractCodexResponseOutputText(event.response);
      }
    }

    const sourceParts = deltaParts.length ? deltaParts : finalTextParts;
    const deduped = [];
    let last = null;
    for (const part of sourceParts) {
      if (part !== last) deduped.push(part);
      last = part;
    }

    const toolCalls = extractCodexResponseFunctionCalls(finalResponse);
    if (!toolCalls.length && streamedToolCalls.size) {
      for (const call of streamedToolCalls.values()) {
        let parsedArguments = {};
        if (call.arguments.trim()) {
          try {
            const parsed = JSON.parse(call.arguments);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              parsedArguments = parsed;
            }
          } catch {
            parsedArguments = {};
          }
        }
        toolCalls.push({
          ...call,
          parsed_arguments: parsedArguments
        });
      }
    }

    return {
      id: responseId,
      output_text: deduped.join("").trim(),
      output_items: toolCalls.map((call) => ({
        type: "function_call",
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments
      })),
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.parsed_arguments,
        arguments_raw: call.arguments
      })),
      usage: finalResponse?.usage || null,
      status: finalResponse?.status || null,
      events
    };
  }

  function makeCodexInputMessage(role, content) {
    return { role, content };
  }

  function decodeInlineTextAsset(asset) {
    const mimeType = String(asset?.mimeType || "").trim().toLowerCase();
    const data = typeof asset?.data === "string" ? asset.data.trim() : "";
    const isTextLike = mimeType.startsWith("text/")
      || mimeType === "application/json"
      || mimeType === "application/xml"
      || mimeType.endsWith("+json")
      || mimeType.endsWith("+xml");

    if (!isTextLike || !data) return null;

    try {
      return Buffer.from(data, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  function isTextLikeMimeType(mimeType) {
    return mimeType.startsWith("text/")
      || mimeType === "application/json"
      || mimeType === "application/xml"
      || mimeType.endsWith("+json")
      || mimeType.endsWith("+xml");
  }

  async function loadWorkspaceAttachment(user, asset) {
    const relPath = typeof asset?.path === "string" ? asset.path.trim() : "";
    if (!user || !relPath || typeof readWorkspaceFile !== "function") return null;

    try {
      return await readWorkspaceFile(user, relPath);
    } catch {
      return null;
    }
  }

  async function buildImageDataUrl(asset, user) {
    const inlineUrl = assetDataUrlInline(asset);
    if (inlineUrl) return inlineUrl;

    const mimeType = typeof asset?.mimeType === "string" ? asset.mimeType.trim() : "";
    if (!mimeType.startsWith("image/")) return null;

    const buffer = await loadWorkspaceAttachment(user, asset);
    if (!buffer || !buffer.length) return null;
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  function assetDataUrlInline(asset) {
    const mimeType = typeof asset?.mimeType === "string" ? asset.mimeType.trim() : "";
    const data = typeof asset?.data === "string" ? asset.data.trim() : "";
    if (!mimeType || !data) return null;
    return `data:${mimeType};base64,${data}`;
  }

  async function decodeTextAsset(asset, user) {
    const mimeType = String(asset?.mimeType || "").trim().toLowerCase();
    if (!mimeType || !isTextLikeMimeType(mimeType)) return null;

    const inlineDecoded = decodeInlineTextAsset(asset);
    if (inlineDecoded !== null) return inlineDecoded;

    const buffer = await loadWorkspaceAttachment(user, asset);
    if (!buffer || !buffer.length) return null;

    try {
      return buffer.toString("utf8");
    } catch {
      return null;
    }
  }

  async function buildCodexFileSummaryPart(file, user) {
    const name = typeof file?.name === "string" && file.name.trim() ? file.name.trim() : "arquivo";
    const mimeType = typeof file?.mimeType === "string" && file.mimeType.trim()
      ? file.mimeType.trim()
      : "application/octet-stream";
    const relPath = typeof file?.path === "string" && file.path.trim() ? file.path.trim() : "";
    const decoded = await decodeTextAsset(file, user);

    if (decoded) {
      const trimmed = decoded.trim();
      const limit = 12000;
      const excerpt = trimmed.slice(0, limit);
      const suffix = trimmed.length > limit ? "\n\n[arquivo truncado]" : "";
      return {
        type: "input_text",
        text: `[Arquivo anexo: ${name} (${mimeType})${relPath ? ` path=${relPath}` : ""}]\n${excerpt}${suffix}`
      };
    }

    return {
      type: "input_text",
      text: `[Arquivo anexo: ${name} (${mimeType})${relPath ? ` path=${relPath}` : ""}]`
    };
  }

  function normalizeChatPath(input) {
    return String(input || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/")
      .trim();
  }

  function resolveArtifactPath(basePath, filePath) {
    const base = normalizeChatPath(basePath);
    const target = normalizeChatPath(filePath);
    if (!target) return base;
    const joined = `${base ? `${base}/` : ""}${target}`;
    const out = [];
    joined.split("/").forEach((part) => {
      if (!part || part === ".") return;
      if (part === "..") {
        if (out.length) out.pop();
        return;
      }
      out.push(part);
    });
    return out.join("/");
  }

  function normalizeArtifactItem(item, basePath = "") {
    const source = item && typeof item === "object" && !Array.isArray(item)
      ? item
      : (typeof item === "string" ? { path: item } : null);
    if (!source) return null;

    const rawPath = source.path || source.workspacePath || source.relPath || "";
    const resolvedPath = rawPath ? resolveArtifactPath(basePath, rawPath) : "";
    const name = typeof source.name === "string" && source.name.trim()
      ? source.name.trim()
      : (resolvedPath.split("/").filter(Boolean).at(-1) || "arquivo");
    const mimeType = typeof source.mimeType === "string" && source.mimeType.trim()
      ? source.mimeType.trim()
      : (typeof source.type === "string" ? source.type.trim() : "");

    return {
      name,
      mimeType,
      ...(resolvedPath ? { path: resolvedPath } : {})
    };
  }

  function extractArtifactsFromResultValue(result, basePath = "") {
    if (!result || typeof result !== "object" || Array.isArray(result)) return [];
    const artifacts = Array.isArray(result.artifacts)
      ? result.artifacts
      : Array.isArray(result.files)
        ? result.files
        : Array.isArray(result.attachments)
          ? result.attachments
          : (result.artifact || result.file || result.attachment
              ? [result.artifact || result.file || result.attachment]
              : []);
    const resolvedBasePath = basePath
      || result.artifact_base_path
      || result.artifactBasePath
      || result.basePath
      || result.cwd
      || "";
    return artifacts
      .map((artifact) => normalizeArtifactItem(artifact, resolvedBasePath))
      .filter(Boolean);
  }

  function parseFunctionCallOutputPayload(item) {
    if (!item || typeof item !== "object" || item.type !== "function_call_output") return null;
    const output = item.output;
    if (output && typeof output === "object" && !Array.isArray(output)) return output;
    const raw = typeof output === "string" ? output.trim() : "";
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function buildToolArtifactContentParts(files, user) {
    const artifacts = Array.isArray(files) ? files : [];
    if (!artifacts.length) return [];

    const content = [];
    const references = [];
    const exactPaths = [];

    for (const file of artifacts) {
      const name = typeof file?.name === "string" && file.name.trim() ? file.name.trim() : "arquivo";
      const mimeType = typeof file?.mimeType === "string" && file.mimeType.trim()
        ? file.mimeType.trim()
        : "application/octet-stream";
      const relPath = typeof file?.path === "string" && file.path.trim() ? file.path.trim() : "";

        if (mimeType.toLowerCase().startsWith("image/")) {
          const imageUrl = await buildImageDataUrl(file, user);
          references.push(`[Imagem retornada por tool: ${name} (${mimeType})${relPath ? ` path=${relPath}` : ""}]`);
          if (relPath) exactPaths.push(relPath);
          if (imageUrl) {
            content.push({
              type: "input_image",
            image_url: imageUrl,
            detail: "auto"
          });
          continue;
        }
        }

        if (relPath) exactPaths.push(relPath);
        content.push(await buildCodexFileSummaryPart(file, user));
      }

      if (references.length) {
        content.unshift({
          type: "input_text",
          text: references.join("\n")
        });
      }

      if (exactPaths.length) {
        const uniquePaths = [...new Set(exactPaths)];
        content.unshift({
          type: "input_text",
          text: `Arquivos retornados por tool. Use exatamente estes paths nas proximas tools: ${uniquePaths.join(", ")}`
        });
      }

      return content;
    }

  async function expandCodexInputItems(inputItems, user = null) {
    const expanded = [];
    const source = Array.isArray(inputItems) ? inputItems : [];

    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      expanded.push(item);

      const payload = parseFunctionCallOutputPayload(item);
      if (!payload) continue;

      const artifacts = extractArtifactsFromResultValue(payload);
      if (!artifacts.length) continue;

      const content = await buildToolArtifactContentParts(artifacts, user);
      if (!content.length) continue;

      expanded.push(makeCodexInputMessage("user", content));
    }

    return expanded;
  }

  async function buildCodexContextMessages(messages, historyLimit, user = null) {
    const normalized = [];
    const source = Array.isArray(messages) ? messages : [];
    const limit = clampCodexHistoryLimit(historyLimit);
    const trimmedSource = source.length > limit ? source.slice(-limit) : source;
    const attachmentIndices = new Set(
      trimmedSource
        .reduce((acc, message, index) => {
          if ((Array.isArray(message?.imgs) && message.imgs.length) || (Array.isArray(message?.files) && message.files.length)) {
            acc.push(index);
          }
          return acc;
        }, [])
        .slice(-3)
    );

    for (let index = 0; index < trimmedSource.length; index += 1) {
      const message = trimmedSource[index];

      if (message?.type === "function_call_output" && typeof message.call_id === "string") {
        normalized.push({
          type: "function_call_output",
          call_id: message.call_id,
          output: typeof message.output === "string" ? message.output : JSON.stringify(message.output ?? {})
        });
        continue;
      }

      if (message?.type === "function_call") {
        const normalizedCall = normalizeCodexFunctionCallItem(message);
        if (normalizedCall) {
          normalized.push({
            type: "function_call",
            id: normalizedCall.id,
            call_id: normalizedCall.call_id,
            name: normalizedCall.name,
            arguments: normalizedCall.arguments
          });
        }
        continue;
      }

      const role = message?.role === "model" ? "assistant"
        : message?.role === "user" ? "user"
          : null;
      if (!role) continue;

      const content = [];
      if (typeof message.text === "string" && message.text.trim()) {
        content.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text: message.text.trim()
        });
      }

      if (role === "user") {
        const includeAttachments = attachmentIndices.has(index);
        const images = Array.isArray(message.imgs) ? message.imgs : [];
        const files = Array.isArray(message.files) ? message.files : [];

        if (includeAttachments) {
          for (const image of images) {
            const imageUrl = await buildImageDataUrl(image, user);
            if (!imageUrl) continue;
            content.push({
              type: "input_image",
              image_url: imageUrl,
              detail: "auto"
            });
          }

          for (const file of files) {
            content.push(await buildCodexFileSummaryPart(file, user));
          }
        } else if (images.length || files.length) {
          const labels = [];
          if (images.length) labels.push(`${images.length} imagem(ns)`);
          if (files.length) labels.push(`${files.length} arquivo(s)`);
          content.push({
            type: "input_text",
            text: `[Anexos omitidos do contexto: ${labels.join(" e ")}]`
          });
        }
      }

      if (!content.length) continue;
      normalized.push(makeCodexInputMessage(role, content));
    }

    return normalized;
  }

  function normalizeCodexTool(tool) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
    if (tool.type !== "function") return null;
    if (typeof tool.name !== "string" || !tool.name.trim()) return null;

    return {
      type: "function",
      name: tool.name.trim(),
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} }
    };
  }

  function buildFakeCodexResponse(messages, userInput, model, sessionId) {
    const responseId = `fake-${sessionId || "skillflow"}-${nowMs()}`;
    return {
      id: responseId,
      object: "response",
      model: model || defaultCodexModel,
      output: [
        {
          id: `msg_${responseId}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `Fake Codex respondeu para ${messages.length || 0} mensagem(ns). Ultimo input: ${userInput || "(vazio)"}`
            }
          ]
        }
      ]
    };
  }

  async function runCodexChat(payload) {
    const auth = await getValidCodexAuth(payload.auth);
    const model = String(payload.model || "").trim() || defaultCodexModel;
    const hasMessages = Array.isArray(payload.messages) && payload.messages.length;
    const contextMessages = hasMessages
      ? await buildCodexContextMessages(payload.messages, payload.history_limit, payload.user || null)
      : (Array.isArray(payload.input) && payload.input.length
          ? await expandCodexInputItems(payload.input, payload.user || null)
          : []);
    const userInput = contextMessages.length
      ? JSON.stringify(contextMessages.at(-1))
      : "";
    const instructions = typeof payload.instructions === "string" && payload.instructions.trim()
      ? payload.instructions.trim()
      : undefined;
    const tools = Array.isArray(payload.tools)
      ? payload.tools.map(normalizeCodexTool).filter(Boolean)
      : [];

    if (!contextMessages.length) {
      throw new Error("Nao foi encontrada nenhuma mensagem valida para enviar ao Codex.");
    }

    if (codexFakeResponses) {
      return {
        auth,
        data: buildFakeCodexResponse(contextMessages, userInput, model, payload.session_id),
        raw: null
      };
    }

    let raw = "";
    const sendCodexRequest = async (includeAccountId = true) => {
      const headers = {
        Authorization: `Bearer ${auth.access}`,
        "Content-Type": "application/json"
      };
      if (includeAccountId && auth.accountId) {
        headers["chatgpt-account-id"] = auth.accountId;
      }

      return fetch(codexResponsesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          store: false,
          stream: true,
          include: ["reasoning.encrypted_content"],
          input: contextMessages,
          instructions,
          ...(tools.length ? { tools } : {})
        })
      });
    };

    let response = await sendCodexRequest(true);
    raw = await response.text();
    if (!response.ok && auth.accountId && auth.accountIdSource !== "provided" && isCodexDeactivatedWorkspaceError(raw)) {
      response = await sendCodexRequest(false);
      raw = await response.text();
    }

    if (!response.ok) {
      throw new Error(raw || `Codex falhou com HTTP ${response.status}`);
    }

    return {
      auth,
      data: parseCodexSsePayload(raw),
      raw
    };
  }

  return {
    buildCodexContextMessages,
    runCodexChat
  };
}
