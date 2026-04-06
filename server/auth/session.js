export function createAuthSession({
  randomBytes,
  sessionTtlSeconds,
  sessionsFile,
  readFile,
  writeFile,
  ensureBaseDirs,
  loadUsers,
  saveUsers,
  ensureUserDirs,
  sanitizeId,
  normalizeLogin,
  hashPassword,
  verifyPassword,
  sendJson,
  parseJsonBody,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  getClientIp,
  enforceRateLimit
}) {
  let sessionStoreCache = null;

  function sanitizeSessionStore(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const now = Date.now();
    const next = {};
    for (const [token, session] of Object.entries(input)) {
      if (!token || !session || typeof session !== "object") continue;
      const userId = sanitizeId(session.userId);
      const expiresAt = Number(session.expiresAt) || 0;
      const createdAt = Number(session.createdAt) || 0;
      if (!userId || expiresAt <= now) continue;
      next[token] = {
        userId,
        createdAt: createdAt || now,
        expiresAt
      };
    }
    return next;
  }

  async function loadSessionStore() {
    if (sessionStoreCache) return sessionStoreCache;
    await ensureBaseDirs();
    try {
      const parsed = JSON.parse(await readFile(sessionsFile, "utf8"));
      sessionStoreCache = sanitizeSessionStore(parsed);
    } catch {
      sessionStoreCache = {};
    }
    return sessionStoreCache;
  }

  async function persistSessionStore(nextStore) {
    sessionStoreCache = sanitizeSessionStore(nextStore);
    await ensureBaseDirs();
    await writeFile(sessionsFile, `${JSON.stringify(sessionStoreCache, null, 2)}\n`, "utf8");
    return sessionStoreCache;
  }

  async function createUser(login, password) {
    const normalizedLogin = normalizeLogin(login);
    if (normalizedLogin.length < 3) throw new Error("Login precisa ter pelo menos 3 caracteres");
    if (String(password || "").length < 4) throw new Error("Senha precisa ter pelo menos 4 caracteres");

    const users = await loadUsers();
    if (users.some((user) => user.login === normalizedLogin)) {
      throw new Error("Login ja existe");
    }

    const user = {
      id: sanitizeId(normalizedLogin),
      login: normalizedLogin,
      password_hash: hashPassword(password),
      created_at: new Date().toISOString()
    };
    users.push(user);
    await saveUsers(users);
    await ensureUserDirs(user);
    return user;
  }

  async function startSession(user) {
    const token = randomBytes(24).toString("hex");
    const sessions = await loadSessionStore();
    sessions[token] = {
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + sessionTtlSeconds * 1000
    };
    await persistSessionStore(sessions);
    return token;
  }

  async function destroySession(token) {
    if (!token) return;
    const sessions = await loadSessionStore();
    if (!sessions[token]) return;
    delete sessions[token];
    await persistSessionStore(sessions);
  }

  async function getAuthenticatedUser(req) {
    const cookies = parseCookies(req);
    const token = cookies.sf_session;
    if (!token) return null;

    const sessions = await loadSessionStore();
    const session = sessions[token];
    if (!session || session.expiresAt < Date.now()) {
      if (session) {
        delete sessions[token];
        await persistSessionStore(sessions);
      }
      return null;
    }

    const users = await loadUsers();
    return users.find((user) => user.id === session.userId) || null;
  }

  async function requireAuth(req, res) {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Unauthorized" });
      return null;
    }
    await ensureUserDirs(user);
    return user;
  }

  async function handleAuthRoutes(req, res, url) {
    if (req.method === "GET" && url.pathname === "/auth/me") {
      const user = await getAuthenticatedUser(req);
      if (!user) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, { user: { id: user.id, login: user.login } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/register") {
      enforceRateLimit(`${getClientIp(req)}:auth:register`);
      const payload = await parseJsonBody(req);
      const user = await createUser(payload.login, payload.password);
      const token = await startSession(user);
      sendJson(res, 200, { ok: true, user: { id: user.id, login: user.login } }, {
        "Set-Cookie": sessionCookie(req, token)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/login") {
      enforceRateLimit(`${getClientIp(req)}:auth:login`);
      const payload = await parseJsonBody(req);
      const login = normalizeLogin(payload.login);
      const password = String(payload.password || "");
      const users = await loadUsers();
      const user = users.find((item) => item.login === login);
      if (!user || !verifyPassword(password, user.password_hash)) {
        sendJson(res, 401, { error: "Login ou senha invalidos" });
        return;
      }
      await ensureUserDirs(user);
      const token = await startSession(user);
      sendJson(res, 200, { ok: true, user: { id: user.id, login: user.login } }, {
        "Set-Cookie": sessionCookie(req, token)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
      const cookies = parseCookies(req);
      if (cookies.sf_session) await destroySession(cookies.sf_session);
      sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(req) });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  }

  return {
    createUser,
    destroySession,
    getAuthenticatedUser,
    handleAuthRoutes,
    requireAuth,
    startSession
  };
}
