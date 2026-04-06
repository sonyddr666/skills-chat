export function createStateModule({
  readFile,
  writeFile,
  ensureUserDirs,
  userStateFile,
  sanitizeUserState,
  stateKeys,
  sendJson,
  parseJsonBody
}) {
  async function loadUserState(user) {
    await ensureUserDirs(user);
    try {
      return sanitizeUserState(JSON.parse(await readFile(userStateFile(user), "utf8")));
    } catch {
      return {};
    }
  }

  async function saveUserState(user, nextState) {
    await ensureUserDirs(user);
    const safeState = sanitizeUserState(nextState);
    await writeFile(userStateFile(user), `${JSON.stringify(safeState, null, 2)}\n`, "utf8");
  }

  async function handleStateApi(req, res, user) {
    if (req.method === "GET") {
      sendJson(res, 200, { state: await loadUserState(user) });
      return;
    }

    if (req.method === "POST") {
      const payload = await parseJsonBody(req);
      const current = await loadUserState(user);
      const next = { ...current };
      const incomingState = payload.state && typeof payload.state === "object" ? payload.state : {};
      for (const key of stateKeys) {
        if (Object.prototype.hasOwnProperty.call(incomingState, key)) {
          next[key] = incomingState[key];
        }
      }
      await saveUserState(user, next);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  }

  return {
    handleStateApi,
    loadUserState,
    saveUserState
  };
}
