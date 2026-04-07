import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthSession } from "./server/auth/session.js";
import { createApprovalsModule } from "./server/approvals/index.js";
import { createCodexModule } from "./server/chat/codex.js";
import { createGeminiModule } from "./server/chat/gemini.js";
import { createChatJobsModule } from "./server/chat/jobs.js";
import { createExecModule } from "./server/exec/index.js";
import { createFilesystemModule } from "./server/filesystem/index.js";
import { createHttpUtils } from "./server/http/utils.js";
import { createStateModule } from "./server/state/index.js";
import { createSystemPromptsModule } from "./server/system-prompts/index.js";

const PORT = Number(process.env.PORT || 9321);
const HOST = "0.0.0.0";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const skillsRootDir = join(__dirname, "skills");
const workspaceRootDir = join(__dirname, "workspace");
const systemDir = join(workspaceRootDir, ".system");
const usersFile = join(systemDir, "users.json");
const userStateDir = join(systemDir, "state");
const systemPromptsDir = join(systemDir, "system-prompts");
const credentialsDir = join(systemDir, "credentials");
const approvalsDir = join(systemDir, "approvals");
const sharedSystemPromptsDir = join(systemPromptsDir, "_shared");
const sessionsFile = join(systemDir, "sessions.json");
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TTS_API_URL = "https://apitts.ghost1.cloud";
const OPENAI_OAUTH_CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_REASONING = "medium";
const DEFAULT_CODEX_HISTORY_LIMIT = 40;
const DEFAULT_CODEX_INSTRUCTIONS = process.env.SKILLFLOW_CODEX_DEFAULT_INSTRUCTIONS
  || "Responda em portugues do Brasil e mantenha continuidade com base na conversa.";
const CODEX_FAKE_RESPONSES = false;
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_FS_READ_MAX_BYTES = 64 * 1024;
const MAX_FS_READ_MAX_BYTES = 512 * 1024;
const EXECUTION_STATE_KEY = "sf_exec";
const APPROVAL_STATE_KEY = "sf_approvals";
const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EXEC_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_EXEC_HISTORY_ITEMS = 100;
const MAX_EXEC_LOG_TAIL_BYTES = 64 * 1024;
const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GLOBAL_APPROVAL_PASSWORD = process.env.SKILLFLOW_MASTER_APPROVAL_PASSWORD || "abelhadomato";
const EXEC_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.SKILLFLOW_EXEC_ENABLED || "").trim().toLowerCase());
const CLIENT_CODE_PLUGINS_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.SKILLFLOW_ENABLE_CLIENT_CODE_PLUGINS || "").trim().toLowerCase());
const LIVE_CLIENT_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.SKILLFLOW_ENABLE_LIVE_CLIENT || "").trim().toLowerCase());
const DEFAULT_EXEC_ALLOWED_BINS = [
  "node",
  "npm",
  "npx",
  "python",
  "python3",
  "py",
  "deno",
  "bash",
  "sh"
];
const EXEC_ALLOW_SHELL = ["1", "true", "yes", "on"].includes(String(process.env.SKILLFLOW_EXEC_ALLOW_SHELL || "").trim().toLowerCase());
const EXEC_ALLOWED_BINS = new Set(
  String(process.env.SKILLFLOW_EXEC_ALLOWED_BINS || DEFAULT_EXEC_ALLOWED_BINS.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);
const EXEC_ALLOW_ALL_BINS = EXEC_ALLOWED_BINS.has("*");
const AUTH_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 12;
const CHAT_JOB_STATUS_RUNNING = "running";
const CHAT_JOB_STATUS_COMPLETED = "completed";
const CHAT_JOB_STATUS_FAILED = "failed";
const TTS_API_URL = String(process.env.SKILLFLOW_TTS_API_URL || DEFAULT_TTS_API_URL).trim();
const TTS_SECRET = String(process.env.SKILLFLOW_TTS_SECRET || "abelhadomato").trim();
const activeExecutions = new Map();
const activeChatJobs = new Map();
const rateLimitStore = new Map();

const STATE_KEYS = [
  "gc_cfg",
  "gc_theme",
  "gc_plugins",
  "gc_convs",
  "gc_activeId",
  "gc_user_memory",
  "gc_pending_approvals",
  "gc_skill_packs",
  "gc_tts_voice",
  "gc_tts_autoplay",
  "gc_sb_collapsed"
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

let {
  attachmentDisposition,
  clearSessionCookie,
  enforceRateLimit,
  getClientIp,
  parseCookies,
  parseJsonBody,
  readRequestBody,
  sendJson,
  sendRedirect,
  sessionCookie
} = createHttpUtils({
  defaultRequestBodyLimitBytes: DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  authRateLimitMaxAttempts: AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  authRateLimitWindowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  rateLimitStore,
  sessionTtlSeconds: SESSION_TTL_SECONDS
});

let authGetAuthenticatedUser;
let authHandleAuthRoutes;
let authRequireAuth;

let stateHandleStateApi;
let stateLoadUserState;
let stateSaveUserState;

let fsEntryTypeFromStats;
let fsHandleFsApi;
let fsNormalizeRelativePath;
let fsWorkspacePath;

let systemPromptsHandleApi;
let systemPromptsNormalizeScope;

let approvalsHandleApi;
let approvalsNormalizeAction;
let approvalsRequireApprovedAction;

let execHandleApi;
let codexBuildContextMessages;
let codexRunChat;
let geminiProxyStream;
let geminiRunChatJob;
let chatJobsHandleApi;
let chatJobsNormalizePayload;

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || "").split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && timingSafeEqual(actual, expectedBuffer);
}

async function ensureBaseDirs() {
  await mkdir(skillsRootDir, { recursive: true });
  await mkdir(workspaceRootDir, { recursive: true });
  await mkdir(systemDir, { recursive: true });
  await mkdir(userStateDir, { recursive: true });
  await mkdir(systemPromptsDir, { recursive: true });
  await mkdir(sharedSystemPromptsDir, { recursive: true });
  await mkdir(credentialsDir, { recursive: true });
  await mkdir(approvalsDir, { recursive: true });
  if (!existsSync(usersFile)) {
    await writeFile(usersFile, "[]\n", "utf8");
  }
  if (!existsSync(sessionsFile)) {
    await writeFile(sessionsFile, "{}\n", "utf8");
  }
}

async function loadUsers() {
  await ensureBaseDirs();
  try {
    return JSON.parse(await readFile(usersFile, "utf8"));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  await ensureBaseDirs();
  await writeFile(usersFile, `${JSON.stringify(users, null, 2)}\n`, "utf8");
}

function userSkillsDir(user) {
  return join(skillsRootDir, user.id);
}

function userWorkspaceDir(user) {
  return join(workspaceRootDir, user.id);
}

function userRunsDir(user) {
  return join(userWorkspaceDir(user), ".runs");
}

function userChatJobsDir(user) {
  return join(userWorkspaceDir(user), ".chat-jobs");
}

function userStateFile(user) {
  return join(userStateDir, `${user.id}.json`);
}

function userCredentialsFile(user) {
  return join(credentialsDir, `${user.id}.json`);
}

function userApprovalsFile(user) {
  return join(approvalsDir, `${user.id}.json`);
}

function userSystemPromptsDir(user) {
  return join(systemPromptsDir, user.id);
}

function sharedSystemPromptFilePath(id) {
  return join(sharedSystemPromptsDir, `${sanitizeId(id)}.json`);
}

function privateSystemPromptFilePath(user, id) {
  return join(userSystemPromptsDir(user), `${sanitizeId(id)}.json`);
}

function legacySystemPromptFilePath(id) {
  return join(systemPromptsDir, `${sanitizeId(id)}.json`);
}

async function ensureUserDirs(user) {
  await ensureBaseDirs();
  await mkdir(userSkillsDir(user), { recursive: true });
  await mkdir(userWorkspaceDir(user), { recursive: true });
  await mkdir(userRunsDir(user), { recursive: true });
  await mkdir(userChatJobsDir(user), { recursive: true });
  await mkdir(userSystemPromptsDir(user), { recursive: true });
  if (!existsSync(userStateFile(user))) {
    await writeFile(userStateFile(user), "{}\n", "utf8");
  }
  if (!existsSync(userCredentialsFile(user))) {
    await writeFile(userCredentialsFile(user), "{}\n", "utf8");
  }
  if (!existsSync(userApprovalsFile(user))) {
    await writeFile(userApprovalsFile(user), "[]\n", "utf8");
  }
}

({
  getAuthenticatedUser: authGetAuthenticatedUser,
  handleAuthRoutes: authHandleAuthRoutes,
  requireAuth: authRequireAuth
} = createAuthSession({
  randomBytes,
  sessionTtlSeconds: SESSION_TTL_SECONDS,
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
}));

async function createUser(login, password) {
  const normalizedLogin = normalizeLogin(login);
  if (normalizedLogin.length < 3) throw new Error("Login precisa ter pelo menos 3 caracteres");
  if (String(password || "").length < 4) throw new Error("Senha precisa ter pelo menos 4 caracteres");

  const users = await loadUsers();
  if (users.some((user) => user.login === normalizedLogin)) {
    throw new Error("Login já existe");
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

function skillFilePath(user, id) {
  return join(userSkillsDir(user), `${id}.json`);
}

function normalizeSkillPayload(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid skill payload");
  }

  const id = sanitizeId(input.id || input.name);
  const name = String(input.name || "").trim().replace(/\s+/g, "_");
  const description = String(input.description || "").trim();

  if (!id) throw new Error("Skill id/name is required");
  if (!name) throw new Error("Skill name is required");
  if (!description) throw new Error("Skill description is required");
  if (input.builtin) throw new Error("Builtin skills cannot be persisted");

  const skill = {
    id,
    builtin: false,
    enabled: input.enabled !== false,
    icon: String(input.icon || "⚙").trim() || "⚙",
    name,
    description,
    parameters: input.parameters && typeof input.parameters === "object"
      ? input.parameters
      : { type: "OBJECT", properties: {} }
  };

  if (input.action && typeof input.action === "object") {
    skill.action = input.action;
  } else if (typeof input.code === "string") {
    skill.code = input.code;
  } else {
    throw new Error("Skill needs action or code");
  }

  return skill;
}

function legacyNormalizeRelativePath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function legacyWorkspacePath(user, input) {
  const root = userWorkspaceDir(user);
  const rel = normalizeRelativePath(input);
  const absolute = resolve(root, rel || ".");
  const back = relative(root, absolute);
  if (back.startsWith("..") || back.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Path escapes workspace root");
  }
  return { rel, absolute };
}

function legacyGenerateChatJobId() {
  return `chat_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function legacyChatJobPaths(user, jobId) {
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

async function legacyWriteChatJobMeta(user, jobId, meta) {
  const paths = legacyChatJobPaths(user, jobId);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

async function legacyReadChatJobMeta(user, jobId) {
  const paths = legacyChatJobPaths(user, jobId);
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

async function legacyReadChatJobSnapshot(user, jobId) {
  const paths = legacyChatJobPaths(user, jobId);
  const meta = await legacyReadChatJobMeta(user, jobId);
  const snapshot = { job: meta };

  if (meta.provider === "gemini" && existsSync(paths.stream)) {
    snapshot.raw_sse = await readFile(paths.stream, "utf8");
  }

  if (existsSync(paths.result)) {
    snapshot.result = JSON.parse(await readFile(paths.result, "utf8"));
  }

  return snapshot;
}

function legacyNormalizeChatJobPayload(input, credentials = {}) {
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
      reasoning: payload.reasoning || DEFAULT_CODEX_REASONING,
      history_limit: payload.history_limit ?? DEFAULT_CODEX_HISTORY_LIMIT,
      instructions: payload.instructions || DEFAULT_CODEX_INSTRUCTIONS,
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

function legacyEntryTypeFromStats(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

async function loadCustomSkills(user) {
  const dir = userSkillsDir(user);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const skills = [];

  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file.name), "utf8");
      const parsed = JSON.parse(raw);
      skills.push(normalizeSkillPayload(parsed));
    } catch (error) {
      console.error(`Failed to load skill ${file.name}:`, error.message);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeChatJobState(chatJob) {
  if (!chatJob || typeof chatJob !== "object" || Array.isArray(chatJob)) return chatJob;
  const next = { ...chatJob };
  if (next.pendingRequest && typeof next.pendingRequest === "object" && !Array.isArray(next.pendingRequest)) {
    const pendingRequest = { ...next.pendingRequest };
    delete pendingRequest.auth;
    delete pendingRequest.api_key;
    delete pendingRequest.apiKey;
    next.pendingRequest = pendingRequest;
  }
  if (next.resumeState && typeof next.resumeState === "object" && !Array.isArray(next.resumeState)) {
    const resumeState = { ...next.resumeState };
    delete resumeState.auth;
    delete resumeState.api_key;
    delete resumeState.apiKey;
    next.resumeState = resumeState;
  }
  return next;
}

function sanitizeConversationMap(conversations) {
  if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) return {};
  const next = {};
  for (const [conversationId, conversation] of Object.entries(conversations)) {
    if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) continue;
    const clonedConversation = { ...conversation };
    if (Array.isArray(conversation.msgs)) {
      clonedConversation.msgs = conversation.msgs.map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) return message;
        const nextMessage = { ...message };
        if (message.chatJob) nextMessage.chatJob = sanitizeChatJobState(message.chatJob);
        return nextMessage;
      });
    }
    next[conversationId] = clonedConversation;
  }
  return next;
}

function sanitizeUserState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  const next = { ...state };
  if (next.gc_cfg && typeof next.gc_cfg === "object" && !Array.isArray(next.gc_cfg)) {
    next.gc_cfg = { ...next.gc_cfg };
    delete next.gc_cfg.key;
    delete next.gc_cfg.codexAuth;
    delete next.gc_cfg.codexAuthRaw;
    delete next.gc_cfg.auth;
    delete next.gc_cfg.token;
    delete next.gc_cfg.apiKey;
    delete next.gc_cfg.api_key;
    delete next.gc_cfg.gemini_api_key;
  }
  if (next.gc_convs) {
    next.gc_convs = sanitizeConversationMap(next.gc_convs);
  }
  return next;
}

({
  handleStateApi: stateHandleStateApi,
  loadUserState: stateLoadUserState,
  saveUserState: stateSaveUserState
} = createStateModule({
  readFile,
  writeFile,
  ensureUserDirs,
  userStateFile,
  sanitizeUserState,
  stateKeys: STATE_KEYS,
  sendJson,
  parseJsonBody
}));

({
  handleSystemPromptsApi: systemPromptsHandleApi,
  normalizeSystemPromptScope: systemPromptsNormalizeScope
} = createSystemPromptsModule({
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
  requireApprovedAction: (...args) => approvalsRequireApprovedAction(...args)
}));

function buildApprovalStateSummary(item) {
  return {
    id: item.id,
    action: item.action,
    status: item.status,
    created_at: item.created_at,
    expires_at: item.expires_at,
    updated_at: item.updated_at
  };
}

async function persistApprovalSummary(user, approval) {
  const state = await stateLoadUserState(user);
  const current = state[APPROVAL_STATE_KEY] && typeof state[APPROVAL_STATE_KEY] === "object"
    ? state[APPROVAL_STATE_KEY]
    : {};
  const recent = Array.isArray(current.recent)
    ? current.recent.filter((item) => item && item.id !== approval.id)
    : [];
  recent.unshift(buildApprovalStateSummary(approval));
  state[APPROVAL_STATE_KEY] = {
    updated_at: new Date().toISOString(),
    recent: recent.slice(0, 100)
  };
  await stateSaveUserState(user, state);
}

async function legacyLoadApprovals(user) {
  await ensureUserDirs(user);
  try {
    const parsed = JSON.parse(await readFile(userApprovalsFile(user), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function legacySaveApprovals(user, approvals) {
  await ensureUserDirs(user);
  const safeApprovals = Array.isArray(approvals) ? approvals : [];
  await writeFile(userApprovalsFile(user), `${JSON.stringify(safeApprovals, null, 2)}\n`, "utf8");
}

function inferExecProfile(payload) {
  const commandName = normalizeExecCommandName(payload.command);
  if (payload.shell) return "shell";
  if (["npm", "npx"].includes(commandName)) return "package_manager";
  if (["node", "python", "python3", "py", "deno", "bash", "sh"].includes(commandName)) return "runtime";
  return "generic";
}

function execProfilePolicy(profile) {
  switch (profile) {
    case "shell":
      return { maxTimeoutMs: 5 * 60 * 1000, maxEnvKeys: 12, allowShell: true };
    case "package_manager":
      return { maxTimeoutMs: 20 * 60 * 1000, maxEnvKeys: 16, allowShell: false };
    case "runtime":
      return { maxTimeoutMs: 30 * 60 * 1000, maxEnvKeys: 16, allowShell: false };
    default:
      return { maxTimeoutMs: 10 * 60 * 1000, maxEnvKeys: 8, allowShell: false };
  }
}

function redactApprovalPayload(action, payload) {
  const safeAction = approvalsNormalizeAction(action);
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  if (safeAction === "exec") {
    const execPayload = normalizeExecPayload(source);
    return {
      title: execPayload.title,
      command: execPayload.command,
      args: execPayload.args,
      shell: execPayload.shell,
      cwd: execPayload.cwd || ".",
      timeout_ms: execPayload.timeoutMs,
      env_keys: Object.keys(execPayload.env),
      stdin_bytes: Buffer.byteLength(execPayload.stdin || "", "utf8"),
      profile: inferExecProfile(execPayload)
    };
  }
  if (safeAction === "fs_delete" || safeAction === "skill_delete" || safeAction === "system_prompt_delete") {
    return {
      path: source.path ? fsNormalizeRelativePath(source.path) : undefined,
      id: source.id ? sanitizeId(source.id) : undefined,
      scope: source.scope ? systemPromptsNormalizeScope(source.scope) : undefined
    };
  }
  if (safeAction === "ghost_search") {
    return {
      query: String(source.query || "").trim().slice(0, 500),
      focus: String(source.focus || "").trim().slice(0, 40),
      model: String(source.model || "").trim().slice(0, 80),
      time_range: String(source.time_range || "").trim().slice(0, 40)
    };
  }
  return JSON.parse(JSON.stringify(source || {}));
}

function legacyNormalizeApprovalPayload(input, user) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Payload de approval invalido");
  }
  const kind = String(input.kind || "single_action").trim().toLowerCase() === "conversation_grant"
    ? "conversation_grant"
    : "single_action";
  const action = approvalsNormalizeAction(input.action);
  if (!action) throw new Error("action ausente");
  const reason = String(input.reason || "").trim();
  if (!reason) throw new Error("reason ausente");
  const risk = String(input.risk || "medio").trim().toLowerCase().slice(0, 40) || "medio";
  const redactedPayload = redactApprovalPayload(action, input.payload);
  const conversationId = normalizeConversationId(input.conversation_id);
  const allowedActions = kind === "conversation_grant"
    ? (Array.isArray(input.allowed_actions) ? input.allowed_actions : ["*"])
      .map((value) => approvalsNormalizeAction(value))
      .filter(Boolean)
    : [action];
  if (kind === "conversation_grant" && !conversationId) {
    throw new Error("conversation_id ausente");
  }
  const now = Date.now();
  const ttlMs = clampApprovalTtlMs(input.expires_in_ms ?? input.ttl_ms ?? (kind === "conversation_grant" ? 24 * 60 * 60 * 1000 : DEFAULT_APPROVAL_TTL_MS));
  const createdAt = new Date(now).toISOString();
  return {
    id: generateApprovalId(),
    kind,
    action,
    reason,
    risk,
    status: "pending",
    conversation_id: conversationId || null,
    allowed_actions: allowedActions.length ? allowedActions : [action],
    used_count: 0,
    requested_by_user_id: user.id,
    requested_by_login: user.login,
    payload_redacted: redactedPayload,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: new Date(now + ttlMs).toISOString(),
    audit: [
      {
        at: createdAt,
        actor_user_id: user.id,
        actor_login: user.login,
        event: "created"
      }
    ]
  };
}

function touchApprovalExpiration(item, user) {
  if (!item || typeof item !== "object") return item;
  if (!item.expires_at || item.status === "expired") return item;
  if (Date.parse(item.expires_at) > Date.now()) return item;
  return {
    ...item,
    status: "expired",
    updated_at: new Date().toISOString(),
    audit: [
      ...(Array.isArray(item.audit) ? item.audit : []),
      {
        at: new Date().toISOString(),
        actor_user_id: user.id,
        actor_login: user.login,
        event: "expired"
      }
    ]
  };
}

async function legacyFindApproval(user, approvalId) {
  const approvals = await legacyLoadApprovals(user);
  const nextApprovals = approvals.map((item) => touchApprovalExpiration(item, user));
  const changed = JSON.stringify(nextApprovals) !== JSON.stringify(approvals);
  if (changed) await legacySaveApprovals(user, nextApprovals);
  const approval = nextApprovals.find((item) => item.id === approvalId) || null;
  return { approval, approvals: nextApprovals };
}

async function legacyUpsertApproval(user, approval) {
  const approvals = await legacyLoadApprovals(user);
  const next = [approval, ...approvals.filter((item) => item && item.id !== approval.id)];
  await legacySaveApprovals(user, next);
  await persistApprovalSummary(user, approval);
  return approval;
}

function legacyApprovalAllowsAction(approval, action, conversationId) {
  if (!approval || approval.kind !== "conversation_grant") return false;
  if (approval.status !== "approved") return false;
  if (approval.conversation_id !== conversationId) return false;
  const allowedActions = Array.isArray(approval.allowed_actions) ? approval.allowed_actions : [];
  return allowedActions.includes("*") || allowedActions.includes(action);
}

function legacySerializeApproval(approval) {
  if (!approval) return null;
  return {
    id: approval.id,
    kind: approval.kind || "single_action",
    action: approval.action,
    conversation_id: approval.conversation_id || null,
    allowed_actions: Array.isArray(approval.allowed_actions) ? approval.allowed_actions : [approval.action].filter(Boolean),
    reason: approval.reason,
    risk: approval.risk,
    status: approval.status,
    used_count: Number(approval.used_count || 0) || 0,
    requested_by_user_id: approval.requested_by_user_id,
    requested_by_login: approval.requested_by_login,
    payload_redacted: approval.payload_redacted,
    created_at: approval.created_at,
    updated_at: approval.updated_at,
    expires_at: approval.expires_at,
    decided_at: approval.decided_at || null,
    decided_by_user_id: approval.decided_by_user_id || null,
    decided_by_login: approval.decided_by_login || null,
    consumed_at: approval.consumed_at || null,
    consumed_by: approval.consumed_by || null,
    audit: Array.isArray(approval.audit) ? approval.audit : []
  };
}

async function legacyRequireApprovedAction(user, approvalId, expectedAction, consumeMeta = null, options = {}) {
  const normalizedAction = approvalsNormalizeAction(expectedAction);
  const id = String(approvalId || "").trim();
  const conversationId = normalizeConversationId(options.conversationId);
  if (!id) {
    if (conversationId) {
      const approvals = await legacyLoadApprovals(user);
      const nextApprovals = approvals.map((item) => touchApprovalExpiration(item, user));
      const grant = nextApprovals.find((item) => legacyApprovalAllowsAction(item, normalizedAction, conversationId));
      if (grant) {
        const now = new Date().toISOString();
        const updatedGrant = {
          ...grant,
          used_count: Number(grant.used_count || 0) + 1,
          updated_at: now,
          audit: [
            ...(Array.isArray(grant.audit) ? grant.audit : []),
            {
              at: now,
              actor_user_id: user.id,
              actor_login: user.login,
              event: "grant_used",
              action: normalizedAction,
              meta: consumeMeta || null
            }
          ]
        };
        await legacySaveApprovals(user, nextApprovals.map((item) => (item.id === updatedGrant.id ? updatedGrant : item)));
        await persistApprovalSummary(user, updatedGrant);
        return updatedGrant;
      }
    }
    const error = new Error("approval_id ausente");
    error.statusCode = 403;
    throw error;
  }
  const { approval, approvals } = await legacyFindApproval(user, id);
  if (!approval) {
    const error = new Error("approval nao encontrado");
    error.statusCode = 403;
    throw error;
  }
  if (approval.requested_by_user_id !== user.id) {
    const error = new Error("approval nao pertence ao usuario autenticado");
    error.statusCode = 403;
    throw error;
  }
  if (approval.kind === "conversation_grant") {
    if (!legacyApprovalAllowsAction(approval, normalizedAction, conversationId || approval.conversation_id)) {
      const error = new Error(`grant invalido para a acao ${normalizedAction}`);
      error.statusCode = 403;
      throw error;
    }
    const now = new Date().toISOString();
    const updatedGrant = {
      ...approval,
      used_count: Number(approval.used_count || 0) + 1,
      updated_at: now,
      audit: [
        ...(Array.isArray(approval.audit) ? approval.audit : []),
        {
          at: now,
          actor_user_id: user.id,
          actor_login: user.login,
          event: "grant_used",
          action: normalizedAction,
          meta: consumeMeta || null
        }
      ]
    };
    await legacySaveApprovals(user, approvals.map((item) => (item.id === updatedGrant.id ? updatedGrant : item)));
    await persistApprovalSummary(user, updatedGrant);
    return updatedGrant;
  }
  if (approval.action !== normalizedAction) {
    const error = new Error(`approval invalido para a acao ${normalizedAction}`);
    error.statusCode = 403;
    throw error;
  }
  if (approval.status !== "approved") {
    const error = new Error(`approval com status invalido: ${approval.status}`);
    error.statusCode = 403;
    throw error;
  }
  const consumedAt = new Date().toISOString();
  const updated = {
    ...approval,
    status: "consumed",
    consumed_at: consumedAt,
    consumed_by: consumeMeta || null,
    updated_at: consumedAt,
    audit: [
      ...(Array.isArray(approval.audit) ? approval.audit : []),
      {
        at: consumedAt,
        actor_user_id: user.id,
        actor_login: user.login,
        event: "consumed",
        meta: consumeMeta || null
      }
    ]
  };
  const next = approvals.map((item) => (item.id === updated.id ? updated : item));
  await legacySaveApprovals(user, next);
  await persistApprovalSummary(user, updated);
  return updated;
}

async function legacyLoadUserState(user) {
  await ensureUserDirs(user);
  try {
    return sanitizeUserState(JSON.parse(await readFile(userStateFile(user), "utf8")));
  } catch {
    return {};
  }
}

async function legacySaveUserState(user, nextState) {
  await ensureUserDirs(user);
  const safeState = sanitizeUserState(nextState);
  await writeFile(userStateFile(user), `${JSON.stringify(safeState, null, 2)}\n`, "utf8");
}

async function loadUserCredentials(user) {
  await ensureUserDirs(user);
  try {
    const parsed = JSON.parse(await readFile(userCredentialsFile(user), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveUserCredentials(user, nextCredentials) {
  await ensureUserDirs(user);
  await writeFile(userCredentialsFile(user), `${JSON.stringify(nextCredentials, null, 2)}\n`, "utf8");
}

function credentialStatusPayload(credentials = {}) {
  return {
    gemini_configured: !!String(credentials.gemini_api_key || "").trim(),
    codex_configured: Boolean(credentials.codex_auth),
    tts_configured: !!(TTS_API_URL && TTS_SECRET)
  };
}

function getConfiguredGeminiApiKey(credentials = {}) {
  return String(credentials.gemini_api_key || "").trim();
}

function getConfiguredCodexAuth(credentials = {}) {
  return credentials.codex_auth || null;
}

function runtimeConfigPayload(credentials = {}) {
  return {
    exec_enabled: EXEC_ENABLED,
    client_code_plugins_enabled: CLIENT_CODE_PLUGINS_ENABLED,
    live_client_enabled: LIVE_CLIENT_ENABLED,
    credentials: credentialStatusPayload(credentials)
  };
}

function parseStoredCodexAuth(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === "object" && !Array.isArray(rawValue)) return rawValue;
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return trimmed;
  return JSON.parse(trimmed);
}

function normalizeCredentialPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Payload de credencial invalido");
  }

  const provider = String(input.provider || "").trim().toLowerCase();
  if (!["gemini", "codex"].includes(provider)) {
    throw new Error("provider invalido");
  }

  const value = String(input.value || "").trim();
  if (!value) {
    throw new Error("value ausente");
  }

  if (provider === "codex") {
    return {
      provider,
      parsedValue: parseStoredCodexAuth(value)
    };
  }

  return {
    provider,
    parsedValue: value
  };
}

function legacyNormalizeSystemPromptScope(inputScope, existingScope = "private") {
  const scope = String(inputScope || existingScope || "private").trim().toLowerCase();
  return scope === "shared" ? "shared" : "private";
}

function systemPromptStorageKey(scope, id) {
  return `${scope}:${sanitizeId(id)}`;
}

async function legacyLoadSystemPromptFromFile(filePath, scope, fallbackOwner = null) {
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
  const normalizedScope = legacyNormalizeSystemPromptScope(payload.scope, scope);
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

async function legacyReadSystemPromptRecord(user, scope, id) {
  const normalizedId = sanitizeId(id);
  const normalizedScope = legacyNormalizeSystemPromptScope(scope);
  if (!normalizedId) return null;
  const filePath = normalizedScope === "shared"
    ? sharedSystemPromptFilePath(normalizedId)
    : privateSystemPromptFilePath(user, normalizedId);

  if (existsSync(filePath)) {
    const item = await legacyLoadSystemPromptFromFile(filePath, normalizedScope, normalizedScope === "private" ? user : null);
    if (item) return { item, filePath };
  }

  if (normalizedScope === "shared") {
    const legacyPath = legacySystemPromptFilePath(normalizedId);
    if (existsSync(legacyPath)) {
      const item = await legacyLoadSystemPromptFromFile(legacyPath, "shared");
      if (item) return { item, filePath: legacyPath };
    }
  }

  return null;
}

function legacyAssertSystemPromptPermission(user, existing) {
  if (!existing) return;
  if (existing.owner_user_id && existing.owner_user_id !== user.id) {
    const error = new Error("Sem permissao para modificar este system prompt");
    error.statusCode = 403;
    throw error;
  }
}

function legacyNormalizeSystemPromptPayload(input, user, existing = null) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid system prompt payload");
  }
  const scope = legacyNormalizeSystemPromptScope(input.scope, existing?.scope || "private");
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

async function legacyListSystemPrompts(user) {
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
        const item = await legacyLoadSystemPromptFromFile(join(source.dir, entry.name), source.scope, source.fallbackOwner);
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
  return clampInteger(value, DEFAULT_EXEC_TIMEOUT_MS, 1000, MAX_EXEC_TIMEOUT_MS);
}

function clampExecHistoryLimit(value) {
  return clampInteger(value, 20, 1, MAX_EXEC_HISTORY_ITEMS);
}

function clampExecLogTailBytes(value) {
  return clampInteger(value, 16 * 1024, 512, MAX_EXEC_LOG_TAIL_BYTES);
}

function clampFsReadMaxBytes(value) {
  return clampInteger(value, DEFAULT_FS_READ_MAX_BYTES, 256, MAX_FS_READ_MAX_BYTES);
}

({
  entryTypeFromStats: fsEntryTypeFromStats,
  handleFsApi: fsHandleFsApi,
  normalizeRelativePath: fsNormalizeRelativePath,
  workspacePath: fsWorkspacePath
} = createFilesystemModule({
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  createReadStream,
  dirname,
  extname,
  join,
  relative,
  resolve,
  processPlatform: process.platform,
  mimeTypes: MIME_TYPES,
  attachmentDisposition,
  sendJson,
  parseJsonBody,
  ensureUserDirs,
  userWorkspaceDir,
  clampFsReadMaxBytes,
  requireApprovedAction: (...args) => approvalsRequireApprovedAction(...args)
}));

function clampApprovalTtlMs(value) {
  return clampInteger(value, DEFAULT_APPROVAL_TTL_MS, 60 * 1000, MAX_APPROVAL_TTL_MS);
}

function parseOptionalBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeApprovalAction(value) {
  if (String(value || "").trim() === "*") return "*";
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function generateApprovalId() {
  return `appr_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

function normalizeConversationId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
}

({
  handleApprovalsApi: approvalsHandleApi,
  normalizeApprovalAction: approvalsNormalizeAction,
  requireApprovedAction: approvalsRequireApprovedAction
} = createApprovalsModule({
  readFile,
  writeFile,
  ensureUserDirs,
  userApprovalsFile,
  approvalStateKey: APPROVAL_STATE_KEY,
  stateLoadUserState,
  stateSaveUserState,
  sanitizeId,
  sendJson,
  parseJsonBody,
  clampApprovalTtlMs,
  defaultApprovalTtlMs: DEFAULT_APPROVAL_TTL_MS,
  globalApprovalPassword: GLOBAL_APPROVAL_PASSWORD,
  generateApprovalId,
  normalizeApprovalAction,
  normalizeConversationId,
  redactApprovalPayload
}));

({
  handleExecApi: execHandleApi
} = createExecModule({
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
  executionStateKey: EXECUTION_STATE_KEY,
  maxExecHistoryItems: MAX_EXEC_HISTORY_ITEMS,
  defaultExecTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
  maxExecTimeoutMs: MAX_EXEC_TIMEOUT_MS,
  maxExecLogTailBytes: MAX_EXEC_LOG_TAIL_BYTES,
  execEnabled: EXEC_ENABLED,
  execAllowAllBins: EXEC_ALLOW_ALL_BINS,
  execAllowedBins: EXEC_ALLOWED_BINS,
  execAllowShell: EXEC_ALLOW_SHELL,
  processEnv: process.env,
  sendJson,
  parseJsonBody,
  parseOptionalBoolean,
  requireApprovedAction: (...args) => approvalsRequireApprovedAction(...args),
  normalizeConversationId,
  inferExecProfile,
  execProfilePolicy
}));

({
  buildCodexContextMessages: codexBuildContextMessages,
  runCodexChat: codexRunChat
} = createCodexModule({
  fetch,
  URLSearchParams,
  Buffer,
  tokenUrl: TOKEN_URL,
  codexResponsesUrl: CODEX_RESPONSES_URL,
  openAiOauthClientId: OPENAI_OAUTH_CLIENT_ID,
  defaultCodexHistoryLimit: DEFAULT_CODEX_HISTORY_LIMIT,
  defaultCodexModel: DEFAULT_CODEX_MODEL,
  codexFakeResponses: CODEX_FAKE_RESPONSES,
  nowMs
}));

({
  proxyGeminiStream: geminiProxyStream,
  runGeminiChatJob: geminiRunChatJob
} = createGeminiModule({
  fetch,
  Buffer,
  geminiApiBaseUrl: GEMINI_API_BASE_URL,
  createWriteStream,
  writeFile,
  mkdir
}));

({
  handleChatJobsApi: chatJobsHandleApi,
  normalizeChatJobPayload: chatJobsNormalizePayload
} = createChatJobsModule({
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
  defaultCodexReasoning: DEFAULT_CODEX_REASONING,
  defaultCodexHistoryLimit: DEFAULT_CODEX_HISTORY_LIMIT,
  defaultCodexInstructions: DEFAULT_CODEX_INSTRUCTIONS,
  chatJobStatusRunning: CHAT_JOB_STATUS_RUNNING,
  chatJobStatusCompleted: CHAT_JOB_STATUS_COMPLETED,
  chatJobStatusFailed: CHAT_JOB_STATUS_FAILED,
  geminiRunChatJob,
  codexRunChat,
  codexBuildContextMessages,
  sendJson,
  parseJsonBody
}));

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

  if (!EXEC_ALLOW_ALL_BINS && !EXEC_ALLOWED_BINS.has(commandName)) {
    const error = new Error(`Comando bloqueado por politica: ${commandName}`);
    error.statusCode = 403;
    throw error;
  }

  if (payload.shell && !EXEC_ALLOW_SHELL) {
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
  const current = state[EXECUTION_STATE_KEY] && typeof state[EXECUTION_STATE_KEY] === "object"
    ? state[EXECUTION_STATE_KEY]
    : {};
  const recent = Array.isArray(current.recent)
    ? current.recent.filter((item) => item && item.id !== summary.id)
    : [];

  recent.unshift(summary);
  state[EXECUTION_STATE_KEY] = {
    last_run_id: summary.id,
    updated_at: new Date().toISOString(),
    recent: recent.slice(0, MAX_EXEC_HISTORY_ITEMS)
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
  const approval = await approvalsRequireApprovedAction(
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
      env: { ...process.env, ...payload.env },
      shell: true,
      stdio: "pipe"
    })
    : spawn(payload.command, payload.args, {
      cwd: workdir.absolute,
      env: { ...process.env, ...payload.env },
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

function nowMs() {
  return Date.now();
}

function legacyClampCodexHistoryLimit(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_CODEX_HISTORY_LIMIT), 10);
  if (Number.isNaN(parsed)) return DEFAULT_CODEX_HISTORY_LIMIT;
  return Math.max(2, Math.min(200, parsed));
}

function legacyDecodeBase64Url(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
}

function legacyDecodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(legacyDecodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function legacyExtractCodexAccountId(token) {
  const payload = legacyDecodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return null;
  const auth = payload["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return null;
  return auth.chatgpt_account_id || null;
}

function legacyParseCodexErrorPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function legacyIsCodexDeactivatedWorkspaceError(raw) {
  const payload = legacyParseCodexErrorPayload(raw);
  if (!payload || typeof payload !== "object") return false;
  const code = payload.detail?.code || payload.error?.code || payload.code || null;
  return String(code || "").trim() === "deactivated_workspace";
}

function legacyNormalizeCodexAuth(input) {
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
  const derivedAccountId = explicitAccountId ? null : legacyExtractCodexAccountId(access);

  return {
    access,
    refresh,
    expires,
    accountId: explicitAccountId || derivedAccountId,
    accountIdSource: explicitAccountId ? "provided" : (derivedAccountId ? "token" : null)
  };
}

async function legacyRefreshCodexAuth(auth) {
  if (!auth.refresh) return auth;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
    client_id: OPENAI_OAUTH_CLIENT_ID
  });

  const response = await fetch(TOKEN_URL, {
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
  const derivedAccountId = explicitAccountId ? null : legacyExtractCodexAccountId(payload.access_token);
  return {
    access: payload.access_token,
    refresh: payload.refresh_token || auth.refresh,
    expires: nowMs() + Number(payload.expires_in || 0) * 1000,
    accountId: explicitAccountId || derivedAccountId,
    accountIdSource: explicitAccountId ? "provided" : (derivedAccountId ? "token" : null)
  };
}

async function legacyGetValidCodexAuth(input) {
  const auth = legacyNormalizeCodexAuth(input);
  if (auth.refresh && auth.expires && auth.expires <= nowMs() + 300000) {
    return legacyRefreshCodexAuth(auth);
  }
  return auth;
}

function legacyCollectSseChunks(value, keyName, chunks) {
  if (Array.isArray(value)) {
    for (const item of value) legacyCollectSseChunks(item, keyName, chunks);
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const nested of Object.values(value)) {
    legacyCollectSseChunks(nested, keyName, chunks);
  }

  if (typeof value[keyName] === "string") {
    chunks.push(value[keyName]);
  }
}

function legacyExtractCodexResponseOutputText(responseObj) {
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

function legacyNormalizeCodexFunctionCallItem(item) {
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

function legacyExtractCodexResponseFunctionCalls(responseObj) {
  const calls = [];
  if (!responseObj || typeof responseObj !== "object") return calls;
  const output = Array.isArray(responseObj.output) ? responseObj.output : [];
  for (const item of output) {
    const normalized = legacyNormalizeCodexFunctionCallItem(item);
    if (normalized) calls.push(normalized);
  }
  return calls;
}

function legacyParseCodexSsePayload(raw) {
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
      legacyCollectSseChunks(event, "delta", deltas);
    for (const delta of deltas) {
      if (typeof delta === "string") deltaParts.push(delta);
    }

    if (event?.type === "response.output_item.added") {
      const normalized = legacyNormalizeCodexFunctionCallItem(event.item);
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
      const normalized = legacyNormalizeCodexFunctionCallItem(event.item);
      if (normalized) {
        const key = Number.isInteger(event.output_index) ? event.output_index : streamedToolCalls.size;
        streamedToolCalls.set(key, normalized);
      }
    }

    if (event?.type === "response.completed") {
      finalResponse = event.response && typeof event.response === "object" ? event.response : null;
      finalTextParts = legacyExtractCodexResponseOutputText(event.response);
    }
  }

  const sourceParts = deltaParts.length ? deltaParts : finalTextParts;
  const deduped = [];
  let last = null;
  for (const part of sourceParts) {
    if (part !== last) deduped.push(part);
    last = part;
  }

  const toolCalls = legacyExtractCodexResponseFunctionCalls(finalResponse);
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

function legacyMakeCodexInputMessage(role, content) {
  return { role, content };
}

function legacyAssetDataUrl(asset) {
  const mimeType = typeof asset?.mimeType === "string" ? asset.mimeType.trim() : "";
  const data = typeof asset?.data === "string" ? asset.data.trim() : "";
  if (!mimeType || !data) return null;
  return `data:${mimeType};base64,${data}`;
}

function legacyDecodeInlineTextAsset(asset) {
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

function legacyBuildCodexFileSummaryPart(file) {
  const name = typeof file?.name === "string" && file.name.trim() ? file.name.trim() : "arquivo";
  const mimeType = typeof file?.mimeType === "string" && file.mimeType.trim()
    ? file.mimeType.trim()
    : "application/octet-stream";
  const decoded = legacyDecodeInlineTextAsset(file);

  if (decoded) {
    const trimmed = decoded.trim();
    const limit = 12000;
    const excerpt = trimmed.slice(0, limit);
    const suffix = trimmed.length > limit ? "\n\n[arquivo truncado]" : "";
    return {
      type: "input_text",
      text: `[Arquivo anexo: ${name} (${mimeType})]\n${excerpt}${suffix}`
    };
  }

  return {
    type: "input_text",
    text: `[Arquivo anexo: ${name} (${mimeType})]`
  };
}

function legacyBuildCodexContextMessages(messages, historyLimit) {
  const normalized = [];
  const source = Array.isArray(messages) ? messages : [];
  const limit = legacyClampCodexHistoryLimit(historyLimit);
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
        const normalizedCall = legacyNormalizeCodexFunctionCallItem(message);
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
            const imageUrl = legacyAssetDataUrl(image);
          if (!imageUrl) continue;
          content.push({
            type: "input_image",
            image_url: imageUrl,
            detail: "auto"
          });
        }

        for (const file of files) {
            content.push(legacyBuildCodexFileSummaryPart(file));
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
    normalized.push(legacyMakeCodexInputMessage(role, content));
  }

  return normalized;
}

function legacyNormalizeCodexTool(tool) {
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

function legacyBuildFakeCodexResponse(messages, userInput, model, sessionId) {
  const responseId = `fake-${sessionId || "skillflow"}-${nowMs()}`;
  return {
    id: responseId,
    output_text: `[fake:${model}] Conversa ${sessionId || "sem-id"} recebeu ${messages.length} mensagens de contexto. Ultima mensagem: ${userInput}`,
    output_items: [],
    tool_calls: [],
    usage: null,
    events: [{ type: "response.completed", response_id: responseId }]
  };
}

async function legacyRunCodexChat(payload) {
  const auth = await legacyGetValidCodexAuth(payload.auth);
  const model = String(payload.model || DEFAULT_CODEX_MODEL);
  const reasoning = String(payload.reasoning || DEFAULT_CODEX_REASONING);
  const instructions = String(payload.instructions || DEFAULT_CODEX_INSTRUCTIONS);
  const contextMessages = Array.isArray(payload.input) && payload.input.length
    ? payload.input
      : legacyBuildCodexContextMessages(payload.messages, payload.history_limit);
  const lastUserInput = [...contextMessages]
    .reverse()
    .find((item) => item?.role === "user" && Array.isArray(item.content));
  const userInput = lastUserInput?.content?.find((part) => part?.type === "input_text" && typeof part.text === "string")
    ?.text || "[mensagem multimodal sem texto]";
  const tools = Array.isArray(payload.tools)
      ? payload.tools.map(legacyNormalizeCodexTool).filter(Boolean)
    : [];

  if (!contextMessages.length || !lastUserInput) {
    throw new Error("Nao foi encontrada nenhuma mensagem valida para enviar ao Codex.");
  }

  if (CODEX_FAKE_RESPONSES) {
    return {
        data: legacyBuildFakeCodexResponse(contextMessages, userInput, model, payload.session_id),
      auth
    };
  }

  const requestBody = JSON.stringify({
    model,
    input: contextMessages,
    store: false,
    stream: true,
    reasoning: { effort: reasoning },
    instructions,
    ...(tools.length ? { tools } : {})
  });
  const sendCodexRequest = async (includeAccountId = true) => {
    const headers = {
      Authorization: `Bearer ${auth.access}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    };
    if (includeAccountId && auth.accountId) {
      headers["chatgpt-account-id"] = auth.accountId;
    }
    return fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: requestBody
    });
  };

  let response = await sendCodexRequest(true);
  let raw = await response.text();
  if (!response.ok && auth.accountId && auth.accountIdSource !== "provided" && legacyIsCodexDeactivatedWorkspaceError(raw)) {
    response = await sendCodexRequest(false);
    raw = await response.text();
  }
  if (!response.ok) {
    throw new Error(raw || `Codex falhou com HTTP ${response.status}`);
  }

  return {
      data: legacyParseCodexSsePayload(raw),
    auth
  };
}

async function legacyProxyGeminiStream(res, payload) {
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

  const apiKey = String(payload.api_key || "").trim();
  if (!apiKey) {
    const error = new Error("Credencial Gemini ausente para este usuario.");
    error.statusCode = 400;
    throw error;
  }

  const upstream = await fetch(
    `${GEMINI_API_BASE_URL}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
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

async function legacyRunGeminiChatJob(user, jobId, payload) {
  const paths = chatJobPaths(user, jobId);
  const apiKey = String(payload.api_key || "").trim();
  if (!apiKey) {
    const error = new Error("Credencial Gemini ausente para este usuario.");
    error.statusCode = 400;
    throw error;
  }

  await mkdir(paths.dir, { recursive: true });
  const upstream = await fetch(
    `${GEMINI_API_BASE_URL}/${encodeURIComponent(payload.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
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

async function legacyRunCodexChatJob(user, jobId, payload) {
  const paths = legacyChatJobPaths(user, jobId);
  await mkdir(paths.dir, { recursive: true });
  const result = await codexRunChat({
    auth: payload.auth,
    model: payload.model,
    reasoning: payload.reasoning || DEFAULT_CODEX_REASONING,
    history_limit: payload.history_limit ?? DEFAULT_CODEX_HISTORY_LIMIT,
    instructions: payload.instructions || DEFAULT_CODEX_INSTRUCTIONS,
    input: payload.input,
    messages: payload.messages,
    tools: payload.tools,
    session_id: payload.session_id || `${user.id}-skillflow`
  });
  const contextItems = Array.isArray(payload.input) && payload.input.length
    ? payload.input
    : codexBuildContextMessages(payload.messages, payload.history_limit);
  const snapshot = {
    ok: true,
    provider: "codex",
    model: payload.model,
    reasoning: payload.reasoning || DEFAULT_CODEX_REASONING,
    context_message_count: contextItems.length,
    payload: result.data
  };
  await writeFile(paths.result, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function legacyFinalizeChatJob(user, jobId, updater) {
  const previous = await legacyReadChatJobMeta(user, jobId);
  const next = {
    ...previous,
    ...updater,
    updated_at: new Date().toISOString()
  };
  if (next.status === CHAT_JOB_STATUS_COMPLETED || next.status === CHAT_JOB_STATUS_FAILED) {
    next.finished_at = next.finished_at || new Date().toISOString();
  }
  await legacyWriteChatJobMeta(user, jobId, next);
  return next;
}

async function legacyExecuteChatJob(user, jobId, payload) {
  activeChatJobs.set(jobId, { startedAt: Date.now(), provider: payload.provider });
  try {
    if (payload.provider === "gemini") {
      await geminiRunChatJob(user, jobId, payload, legacyChatJobPaths);
    } else if (payload.provider === "codex") {
      await legacyRunCodexChatJob(user, jobId, payload);
    } else {
      const error = new Error("Unsupported provider for backend chat route");
      error.statusCode = 400;
      throw error;
    }

    await legacyFinalizeChatJob(user, jobId, {
      status: CHAT_JOB_STATUS_COMPLETED,
      error: null
    });
  } catch (error) {
    await legacyFinalizeChatJob(user, jobId, {
      status: CHAT_JOB_STATUS_FAILED,
      error: {
        message: error.message,
        statusCode: error.statusCode || 500
      }
    });
  } finally {
    activeChatJobs.delete(jobId);
  }
}

async function legacyCreateChatJob(user, input) {
  await ensureUserDirs(user);
  const credentials = await loadUserCredentials(user);
  const payload = legacyNormalizeChatJobPayload(input, credentials);
  const jobId = legacyGenerateChatJobId();
  const meta = {
    id: jobId,
    provider: payload.provider,
    model: payload.model,
    status: CHAT_JOB_STATUS_RUNNING,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: null,
    error: null
  };
  await legacyWriteChatJobMeta(user, jobId, meta);
  legacyExecuteChatJob(user, jobId, payload).catch((error) => {
    console.error(`[ChatJob] ${jobId} falhou:`, error);
  });
  return meta;
}

async function handleChatApi(req, res, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/api/chat", `http://${req.headers.host}`);

  if (await chatJobsHandleApi(req, res, url, user, loadUserCredentials)) {
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/api/chat") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const payload = await parseJsonBody(req);
  const credentials = await loadUserCredentials(user);
  const normalized = chatJobsNormalizePayload(payload, credentials);
  const provider = normalized.provider;

  if (provider === "gemini") {
    await geminiProxyStream(res, normalized);
    return;
  }

  const result = await codexRunChat({
    auth: normalized.auth,
    model: normalized.model,
    reasoning: normalized.reasoning || DEFAULT_CODEX_REASONING,
    history_limit: normalized.history_limit ?? DEFAULT_CODEX_HISTORY_LIMIT,
    instructions: normalized.instructions || DEFAULT_CODEX_INSTRUCTIONS,
    input: Array.isArray(normalized.input) ? normalized.input : null,
    messages: normalized.messages,
    tools: normalized.tools,
    session_id: normalized.session_id || `${user.id}-skillflow`
  });

  const contextItems = Array.isArray(normalized.input) && normalized.input.length
    ? normalized.input
    : codexBuildContextMessages(normalized.messages, normalized.history_limit);

  sendJson(res, 200, {
    ok: true,
    provider: "codex",
    model: normalized.model,
    reasoning: normalized.reasoning || DEFAULT_CODEX_REASONING,
    context_message_count: contextItems.length,
    payload: result.data
  });
}

async function legacyHandleAuthRoutes(req, res, url) {
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
      sendJson(res, 401, { error: "Login ou senha inválidos" });
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

async function handleGhostSearch(req, res, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const payload = await parseJsonBody(req);
    await approvalsRequireApprovedAction(user, payload.approval_id, "ghost_search", {
      route: "/api/ghost-search",
      query: String(payload.query || "").trim().slice(0, 120)
    }, {
      conversationId: payload.conversation_id
    });
    delete payload.approval_id;
    if (!payload.user_id) payload.user_id = user.id;

    const upstream = await fetch("https://api.ghost1.cloud/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(text);
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : `ghost-search proxy failed: ${error.message}`
    });
  }
}

async function handleSkillsApi(req, res, url, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    sendJson(res, 200, { skills: await loadCustomSkills(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/skills") {
    const payload = await parseJsonBody(req);
    const skill = normalizeSkillPayload(payload);
    await writeFile(skillFilePath(user, skill.id), `${JSON.stringify(skill, null, 2)}\n`, "utf8");
    sendJson(res, 200, { ok: true, skill });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/skills/")) {
    const id = sanitizeId(url.pathname.slice("/api/skills/".length));
    if (!id) {
      sendJson(res, 400, { error: "Skill id is required" });
      return;
    }
    const filePath = skillFilePath(user, id);
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }
    await approvalsRequireApprovedAction(user, url.searchParams.get("approval_id"), "skill_delete", {
      route: "/api/skills/:id",
      id
    }, {
      conversationId: url.searchParams.get("conversation_id")
    });
    await unlink(filePath);
    sendJson(res, 200, { ok: true, id });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function legacyHandleSystemPromptsApi(req, res, url, user) {
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
    sendJson(res, 200, { items: await legacyListSystemPrompts(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/system-prompts") {
    const payload = await parseJsonBody(req);
    const scope = legacyNormalizeSystemPromptScope(payload.scope);
    const existingRecord = await legacyReadSystemPromptRecord(user, scope, payload.id || payload.name);
    const existing = existingRecord?.item || null;
    legacyAssertSystemPromptPermission(user, existing);
    const next = legacyNormalizeSystemPromptPayload(payload, user, existing);
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
    const scope = legacyNormalizeSystemPromptScope(rawScope);
    const id = sanitizeId(rawId);
    if (!id) {
      sendJson(res, 400, { error: "System prompt id is required" });
      return;
    }
    const existingRecord = await legacyReadSystemPromptRecord(user, scope, id);
    if (!existingRecord?.item || !existingRecord?.filePath) {
      sendJson(res, 404, { error: "System prompt not found" });
      return;
    }
    legacyAssertSystemPromptPermission(user, existingRecord.item);
    await approvalsRequireApprovedAction(user, url.searchParams.get("approval_id"), "system_prompt_delete", {
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

async function legacyHandleFsApi(req, res, url, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  await ensureUserDirs(user);

  if (req.method === "GET" && url.pathname === "/api/fs/list") {
    const requestedPath = url.searchParams.get("path") || "";
    const { rel, absolute } = workspacePath(user, requestedPath);
    const entries = await readdir(absolute, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      const childRel = normalizeRelativePath(join(rel, entry.name));
      const child = workspacePath(user, childRel);
      const stats = await lstat(child.absolute);
      items.push({
        name: entry.name,
        path: childRel,
        type: entryTypeFromStats(stats),
        size: stats.size,
        updated_at: stats.mtime.toISOString()
      });
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sendJson(res, 200, { path: rel, items });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/fs/read") {
    const requestedPath = url.searchParams.get("path") || "";
    const maxBytes = clampFsReadMaxBytes(url.searchParams.get("max_bytes"));
    const { rel, absolute } = workspacePath(user, requestedPath);
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      sendJson(res, 400, { error: "Path is not a file" });
      return;
    }
    const buffer = await readFile(absolute);
    const truncated = buffer.length > maxBytes;
    const content = (truncated ? buffer.subarray(0, maxBytes) : buffer).toString("utf8");
    sendJson(res, 200, {
      path: rel,
      type: "file",
      size: stats.size,
      updated_at: stats.mtime.toISOString(),
      max_bytes: maxBytes,
      truncated,
      content
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/fs/download") {
    const requestedPath = url.searchParams.get("path") || "";
    if (!requestedPath) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, requestedPath);
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      sendJson(res, 400, { error: "Path is not a file" });
      return;
    }

    const fileName = rel.split("/").filter(Boolean).at(-1) || "download";
    const contentType = MIME_TYPES[extname(absolute).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Content-Disposition": attachmentDisposition(fileName),
      "Cache-Control": "no-store"
    });
    createReadStream(absolute).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fs/write") {
    const payload = await parseJsonBody(req);
    if (!payload.path) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, payload.path);
    const createDirs = payload.create_dirs !== false && payload.create_dirs !== "false";
    if (createDirs) await mkdir(dirname(absolute), { recursive: true });
    if (String(payload.encoding || "").trim().toLowerCase() === "base64") {
      await writeFile(absolute, Buffer.from(String(payload.content || ""), "base64"));
    } else {
      await writeFile(absolute, String(payload.content ?? ""), "utf8");
    }
    const stats = await lstat(absolute);
    sendJson(res, 200, {
      ok: true,
      path: rel,
      type: "file",
      size: stats.size,
      updated_at: stats.mtime.toISOString()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fs/mkdir") {
    const payload = await parseJsonBody(req);
    if (!payload.path) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, payload.path);
    await mkdir(absolute, { recursive: true });
    sendJson(res, 200, { ok: true, path: rel, type: "directory" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fs/rename") {
    const payload = await parseJsonBody(req);
    if (!payload.path || !payload.next_path) {
      sendJson(res, 400, { error: "path and next_path are required" });
      return;
    }
    const source = workspacePath(user, payload.path);
    const target = workspacePath(user, payload.next_path);
    await mkdir(dirname(target.absolute), { recursive: true });
    await rename(source.absolute, target.absolute);
    const stats = await lstat(target.absolute);
    sendJson(res, 200, {
      ok: true,
      from: source.rel,
      to: target.rel,
      type: entryTypeFromStats(stats),
      size: stats.size,
      updated_at: stats.mtime.toISOString()
    });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/fs/delete") {
    const requestedPath = url.searchParams.get("path") || "";
    if (!requestedPath) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, requestedPath);
    await lstat(absolute);
    await approvalsRequireApprovedAction(user, url.searchParams.get("approval_id"), "fs_delete", {
      route: "/api/fs/delete",
      path: requestedPath
    }, {
      conversationId: url.searchParams.get("conversation_id")
    });
    await rm(absolute, { recursive: true, force: false });
    sendJson(res, 200, { ok: true, path: rel });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleRuntimeConfigApi(req, res, user) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const credentials = await loadUserCredentials(user);
  sendJson(res, 200, {
    ok: true,
    runtime: runtimeConfigPayload(credentials)
  });
}

async function handleCredentialsApi(req, res, user) {
  if (req.method === "GET") {
    const credentials = await loadUserCredentials(user);
    sendJson(res, 200, {
      ok: true,
      credentials: credentialStatusPayload(credentials)
    });
    return;
  }

  if (req.method === "POST") {
    const payload = normalizeCredentialPayload(await parseJsonBody(req));
    const current = await loadUserCredentials(user);
    const next = { ...current };
    if (payload.provider === "gemini") {
      next.gemini_api_key = payload.parsedValue;
    } else if (payload.provider === "codex") {
      next.codex_auth = payload.parsedValue;
    }
    await saveUserCredentials(user, next);
    sendJson(res, 200, {
      ok: true,
      credentials: credentialStatusPayload(next)
    });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function legacyHandleApprovalsApi(req, res, url, user) {
  if (req.method === "GET" && url.pathname === "/api/approvals") {
    const approvals = await legacyLoadApprovals(user);
    sendJson(res, 200, {
      ok: true,
      items: approvals.map(legacySerializeApproval)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approvals") {
    const payload = await parseJsonBody(req);
    const approval = legacyNormalizeApprovalPayload(payload, user);
    await legacyUpsertApproval(user, approval);
    sendJson(res, 201, { ok: true, item: legacySerializeApproval(approval) });
    return;
  }

  if (!url.pathname.startsWith("/api/approvals/")) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const parts = url.pathname.slice("/api/approvals/".length).split("/").filter(Boolean);
  const approvalId = String(parts[0] || "").trim();
  if (!approvalId) {
    sendJson(res, 400, { error: "approval id ausente" });
    return;
  }

  const { approval, approvals } = await legacyFindApproval(user, approvalId);
  if (!approval) {
    sendJson(res, 404, { error: "approval nao encontrado" });
    return;
  }

  if (parts.length === 1 && req.method === "GET") {
    sendJson(res, 200, { ok: true, item: legacySerializeApproval(approval) });
    return;
  }

  const action = parts[1] || "";
  if (req.method === "POST" && (action === "approve" || action === "reject" || action === "revoke")) {
    if (approval.status !== "pending") {
      if (action !== "revoke" || !["approved", "pending"].includes(approval.status)) {
        sendJson(res, 409, { error: `approval nao pode mudar de status: ${approval.status}` });
        return;
      }
    }
    const now = new Date().toISOString();
    const nextStatus = action === "approve" ? "approved" : (action === "reject" ? "rejected" : "revoked");
    const next = {
      ...approval,
      status: nextStatus,
      decided_at: now,
      decided_by_user_id: user.id,
      decided_by_login: user.login,
      updated_at: now,
      audit: [
        ...(Array.isArray(approval.audit) ? approval.audit : []),
        {
          at: now,
          actor_user_id: user.id,
          actor_login: user.login,
          event: nextStatus
        }
      ]
    };
    await legacySaveApprovals(user, approvals.map((item) => (item.id === next.id ? next : item)));
    await persistApprovalSummary(user, next);
    sendJson(res, 200, { ok: true, item: legacySerializeApproval(next) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function proxyTtsRequest(pathname, options = {}) {
  if (!TTS_API_URL || !TTS_SECRET) {
    const error = new Error("TTS indisponivel por politica do servidor.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${TTS_API_URL}${pathname}`, {
    ...options,
    headers: {
      "x-secret": TTS_SECRET,
      ...(options.headers || {})
    }
  });

  return response;
}

async function handleTtsApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/tts/health") {
    const upstream = await proxyTtsRequest("/health");
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8"
    });
    res.end(text);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tts/voices") {
    const upstream = await proxyTtsRequest("/vozes");
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8"
    });
    res.end(text);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tts/speak") {
    const payload = await parseJsonBody(req);
    const upstream = await proxyTtsRequest("", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chavesecreta: TTS_SECRET,
        voz: payload.voice,
        texto: payload.text
      })
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
      "Content-Length": buffer.length
    });
    res.end(buffer);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function legacyHandleExecApi(req, res, url, user) {
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
    if (!EXEC_ENABLED) {
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

async function legacyHandleStateApi(req, res, user) {
  if (req.method === "GET") {
    sendJson(res, 200, { state: await loadUserState(user) });
    return;
  }

  if (req.method === "POST") {
    const payload = await parseJsonBody(req);
    const current = await loadUserState(user);
    const next = { ...current };
    const incomingState = payload.state && typeof payload.state === "object" ? payload.state : {};
    for (const key of STATE_KEYS) {
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

async function serveStatic(req, res, user) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/index.html") {
    if (!user) {
      const loginPath = join(publicDir, "login.html");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
      });
      createReadStream(loginPath).pipe(res);
      return;
    }
    pathname = "/index.html";
  }

  if (pathname === "/login" || pathname === "/login.html") {
    if (user) {
      sendRedirect(res, "/");
      return;
    }
    pathname = "/login.html";
  }

  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const fallbackPath = join(publicDir, user ? "index.html" : "login.html");
  const finalPath = existsSync(filePath) ? filePath : fallbackPath;
  const ext = extname(finalPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  const noCacheExt = [".html", ".css", ".js"].includes(ext);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": noCacheExt ? "no-cache, no-store, must-revalidate" : "public, max-age=3600",
    "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  createReadStream(finalPath).pipe(res);
}

function handleHealthRoute(res, user) {
  sendJson(res, 200, {
    status: "ok",
    service: "skillflow-node-9321",
    port: PORT,
    authenticated: Boolean(user),
    codex_fake_responses: CODEX_FAKE_RESPONSES
  });
}

function matchApiRoute(pathname, route) {
  const exactMatch = route.exact ? pathname === route.exact : false;
  const prefixMatch = route.prefix ? pathname === route.prefix || pathname.startsWith(route.prefix) : false;
  return exactMatch || prefixMatch;
}

async function dispatchAuthenticatedApiRoute(req, res, url, user) {
  const apiRoutes = [
    { exact: "/api/ghost-search", handler: (authUser) => handleGhostSearch(req, res, authUser) },
    { exact: "/api/runtime-config", handler: (authUser) => handleRuntimeConfigApi(req, res, authUser) },
    { exact: "/api/credentials", handler: (authUser) => handleCredentialsApi(req, res, authUser) },
    { prefix: "/api/approvals/", exact: "/api/approvals", handler: (authUser) => approvalsHandleApi(req, res, url, authUser) },
    { prefix: "/api/tts/", handler: () => handleTtsApi(req, res, url) },
    { prefix: "/api/chat/", exact: "/api/chat", handler: (authUser) => handleChatApi(req, res, authUser) },
    { exact: "/api/state", handler: (authUser) => stateHandleStateApi(req, res, authUser) },
    { prefix: "/api/skills/", exact: "/api/skills", handler: (authUser) => handleSkillsApi(req, res, url, authUser) },
    { prefix: "/api/exec/", exact: "/api/exec", handler: (authUser) => execHandleApi(req, res, url, authUser) },
    { prefix: "/api/system-prompts/", exact: "/api/system-prompts", handler: (authUser) => systemPromptsHandleApi(req, res, url, authUser) },
    { prefix: "/api/fs/", handler: (authUser) => fsHandleFsApi(req, res, url, authUser) }
  ];

  for (const route of apiRoutes) {
    if (matchApiRoute(url.pathname, route)) {
      await route.handler(user);
      return true;
    }
  }

  return false;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const user = await authGetAuthenticatedUser(req);

  if (url.pathname === "/health") {
    handleHealthRoute(res, user);
    return;
  }

  if (url.pathname.startsWith("/auth/")) {
    try {
      await authHandleAuthRoutes(req, res, url);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: `auth failed: ${error.message}` });
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const authUser = user || await authRequireAuth(req, res);
    if (!authUser) return;

    try {
      const handled = await dispatchAuthenticatedApiRoute(req, res, url, authUser);
      if (!handled) {
        sendJson(res, 404, { error: "Not found" });
      }
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: `api failed: ${error.message}` });
    }
    return;
  }

  try {
    await serveStatic(req, res, user);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: `static-serve failed: ${error.message}` });
  }
}

const server = createServer(handleRequest);

ensureBaseDirs()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`SkillFlow server listening on ${HOST}:${PORT} (all container interfaces)`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize server:", error);
    process.exit(1);
  });
