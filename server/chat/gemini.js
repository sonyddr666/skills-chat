export function createGeminiModule({
  fetch,
  Buffer,
  geminiApiBaseUrl,
  createWriteStream,
  writeFile,
  mkdir
}) {
  function getGeminiApiKey(payload) {
    return String(payload.api_key || "").trim();
  }

  function assertGeminiPayload(payload) {
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

    const apiKey = getGeminiApiKey(payload);
    if (!apiKey) {
      const error = new Error("Credencial Gemini ausente para este usuario.");
      error.statusCode = 400;
      throw error;
    }

    return {
      apiKey,
      model
    };
  }

  async function openGeminiStream(payload) {
    const { apiKey, model } = assertGeminiPayload(payload);
    const upstream = await fetch(
      `${geminiApiBaseUrl}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.request)
      }
    );

    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text();
      const error = new Error(raw || `Gemini falhou com HTTP ${upstream.status}`);
      error.statusCode = upstream.status || 502;
      throw error;
    }

    return upstream;
  }

  async function proxyGeminiStream(res, payload) {
    const upstream = await openGeminiStream(payload);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });

    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  }

  async function runGeminiChatJob(user, jobId, payload, chatJobPaths) {
    const paths = chatJobPaths(user, jobId);
    const upstream = await openGeminiStream(payload);

    await mkdir(paths.dir, { recursive: true });
    const stream = createWriteStream(paths.stream, { flags: "w", encoding: "utf8" });
    try {
      for await (const chunk of upstream.body) {
        if (!stream.write(Buffer.from(chunk).toString("utf8"))) {
          await new Promise((resolve) => stream.once("drain", resolve));
        }
      }
      stream.end();
      await new Promise((resolve, reject) => {
        stream.on("finish", resolve);
        stream.on("error", reject);
      });
      await writeFile(paths.result, `${JSON.stringify({ ok: true, provider: "gemini" }, null, 2)}\n`, "utf8");
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  return {
    proxyGeminiStream,
    runGeminiChatJob
  };
}
