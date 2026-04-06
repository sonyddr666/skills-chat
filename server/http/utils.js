export function createHttpUtils({
  defaultRequestBodyLimitBytes,
  authRateLimitMaxAttempts,
  authRateLimitWindowMs,
  rateLimitStore,
  sessionTtlSeconds
}) {
  function sendJson(res, status, payload, extraHeaders = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...extraHeaders
    });
    res.end(JSON.stringify(payload));
  }

  function sendRedirect(res, location) {
    res.writeHead(302, {
      Location: location,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    res.end();
  }

  function attachmentDisposition(fileName) {
    const fallback = String(fileName || "download")
      .replace(/["\\]/g, "_")
      .replace(/[^\x20-\x7E]+/g, "_")
      .trim() || "download";
    const encoded = encodeURIComponent(String(fileName || fallback));
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  }

  async function readRequestBody(req, maxBytes = defaultRequestBodyLimitBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("Payload too large");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function parseJsonBody(req, maxBytes = defaultRequestBodyLimitBytes) {
    const raw = await readRequestBody(req, maxBytes);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error("Invalid JSON body");
      error.statusCode = 400;
      throw error;
    }
  }

  function parseCookies(req) {
    const raw = req.headers.cookie || "";
    return raw.split(";").reduce((acc, item) => {
      const [k, ...rest] = item.trim().split("=");
      if (!k) return acc;
      acc[k] = decodeURIComponent(rest.join("="));
      return acc;
    }, {});
  }

  function isHttpsRequest(req) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").trim().toLowerCase();
    if (forwardedProto) {
      return forwardedProto.split(",")[0].trim() === "https";
    }
    return Boolean(req.socket?.encrypted);
  }

  function sessionCookie(req, token) {
    const secure = isHttpsRequest(req) ? "; Secure" : "";
    return `sf_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}${secure}`;
  }

  function clearSessionCookie(req) {
    const secure = isHttpsRequest(req) ? "; Secure" : "";
    return `sf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }

  function getClientIp(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").trim();
    if (forwarded) return forwarded.split(",")[0].trim();
    return String(req.socket?.remoteAddress || "unknown");
  }

  function enforceRateLimit(key, max = authRateLimitMaxAttempts, windowMs = authRateLimitWindowMs) {
    const now = Date.now();
    const current = rateLimitStore.get(key);
    const entry = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    rateLimitStore.set(key, entry);
    if (entry.count > max) {
      const error = new Error("Rate limit exceeded");
      error.statusCode = 429;
      throw error;
    }
  }

  return {
    attachmentDisposition,
    clearSessionCookie,
    enforceRateLimit,
    getClientIp,
    isHttpsRequest,
    parseCookies,
    parseJsonBody,
    readRequestBody,
    sendJson,
    sendRedirect,
    sessionCookie
  };
}
