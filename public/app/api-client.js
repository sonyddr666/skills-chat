(function initSkillFlowApiClient(global) {
  function mergeHeaders(baseHeaders, extraHeaders) {
    return {
      ...(baseHeaders || {}),
      ...(extraHeaders || {})
    };
  }

  async function request(url, options) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: mergeHeaders(options?.headers)
    });

    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (contentType.includes("application/json")) {
      data = await response.json().catch(() => ({}));
    } else {
      const text = await response.text().catch(() => "");
      data = { error: text };
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      response
    };
  }

  async function fetchJson(url, options) {
    const result = await request(url, options);
    if (!result.ok) {
      throw new Error(result.data?.error || `HTTP ${result.status}`);
    }
    return result.data;
  }

  async function getRuntimeConfig() {
    const result = await request("/api/runtime-config");
    return result.data;
  }

  async function saveProviderCredential(provider, value) {
    return fetchJson("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, value })
    });
  }

  async function requestCodexChat(payload, signal) {
    return fetchJson("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal
    });
  }

  global.SkillFlowApi = {
    fetchJson,
    getRuntimeConfig,
    request,
    requestCodexChat,
    saveProviderCredential
  };
})(window);
