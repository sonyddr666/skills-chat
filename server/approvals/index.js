export function createApprovalsModule({
  readFile,
  writeFile,
  ensureUserDirs,
  userApprovalsFile,
  approvalStateKey,
  stateLoadUserState,
  stateSaveUserState,
  sanitizeId,
  sendJson,
  parseJsonBody,
  clampApprovalTtlMs,
  defaultApprovalTtlMs,
  globalApprovalPassword,
  generateApprovalId,
  normalizeApprovalAction,
  normalizeConversationId,
  redactApprovalPayload
}) {
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
    const current = state[approvalStateKey] && typeof state[approvalStateKey] === "object"
      ? state[approvalStateKey]
      : {};
    const recent = Array.isArray(current.recent)
      ? current.recent.filter((item) => item && item.id !== approval.id)
      : [];
    recent.unshift(buildApprovalStateSummary(approval));
    state[approvalStateKey] = {
      updated_at: new Date().toISOString(),
      recent: recent.slice(0, 100)
    };
    await stateSaveUserState(user, state);
  }

  async function loadApprovals(user) {
    await ensureUserDirs(user);
    try {
      const parsed = JSON.parse(await readFile(userApprovalsFile(user), "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function saveApprovals(user, approvals) {
    await ensureUserDirs(user);
    const safeApprovals = Array.isArray(approvals) ? approvals : [];
    await writeFile(userApprovalsFile(user), `${JSON.stringify(safeApprovals, null, 2)}\n`, "utf8");
  }

  function isGlobalGrant(approval) {
    return approval && approval.kind === "global_grant";
  }

  function normalizeApprovalPayload(input, user) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Payload de approval invalido");
    }
    const rawKind = String(input.kind || "single_action").trim().toLowerCase();
    const kind = rawKind === "conversation_grant"
      ? "conversation_grant"
      : (rawKind === "global_grant" ? "global_grant" : "single_action");
    const action = normalizeApprovalAction(input.action || (kind === "global_grant" ? "*" : ""));
    if (!action) throw new Error("action ausente");
    const reason = String(input.reason || "").trim();
    if (!reason) throw new Error("reason ausente");
    const risk = String(input.risk || "medio").trim().toLowerCase().slice(0, 40) || "medio";
    const redactedPayload = redactApprovalPayload(action, input.payload);
    const conversationId = normalizeConversationId(input.conversation_id);
    const allowedActions = kind !== "single_action"
      ? (Array.isArray(input.allowed_actions) ? input.allowed_actions : ["*"])
        .map((value) => normalizeApprovalAction(value))
        .filter(Boolean)
      : [action];
    if (kind === "conversation_grant" && !conversationId) {
      throw new Error("conversation_id ausente");
    }
    if (kind === "global_grant") {
      const providedPassword = String(input.password || "").trim();
      if (!providedPassword || providedPassword !== String(globalApprovalPassword || "").trim()) {
        const error = new Error("senha mestra invalida");
        error.statusCode = 403;
        throw error;
      }
    }
    const now = Date.now();
    const ttlMs = clampApprovalTtlMs(input.expires_in_ms ?? input.ttl_ms ?? ((kind === "conversation_grant" || kind === "global_grant") ? 24 * 60 * 60 * 1000 : defaultApprovalTtlMs));
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

  async function findApproval(user, approvalId) {
    const approvals = await loadApprovals(user);
    const nextApprovals = approvals.map((item) => touchApprovalExpiration(item, user));
    const changed = JSON.stringify(nextApprovals) !== JSON.stringify(approvals);
    if (changed) await saveApprovals(user, nextApprovals);
    const approval = nextApprovals.find((item) => item.id === approvalId) || null;
    return { approval, approvals: nextApprovals };
  }

  async function upsertApproval(user, approval) {
    const approvals = await loadApprovals(user);
    const next = [approval, ...approvals.filter((item) => item && item.id !== approval.id)];
    await saveApprovals(user, next);
    await persistApprovalSummary(user, approval);
    return approval;
  }

  function approvalAllowsAction(approval, action, conversationId) {
    if (!approval || !["conversation_grant", "global_grant"].includes(String(approval.kind || ""))) return false;
    if (approval.status !== "approved") return false;
    if (!isGlobalGrant(approval) && approval.conversation_id !== conversationId) return false;
    const allowedActions = Array.isArray(approval.allowed_actions) ? approval.allowed_actions : [];
    return allowedActions.includes("*") || allowedActions.includes(action);
  }

  function serializeApproval(approval) {
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

  async function requireApprovedAction(user, approvalId, expectedAction, consumeMeta = null, options = {}) {
    const normalizedAction = normalizeApprovalAction(expectedAction);
    const id = String(approvalId || "").trim();
    const conversationId = normalizeConversationId(options.conversationId);
    if (!id) {
      {
        const approvals = await loadApprovals(user);
        const nextApprovals = approvals.map((item) => touchApprovalExpiration(item, user));
        const grant = nextApprovals.find((item) => approvalAllowsAction(item, normalizedAction, conversationId));
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
          await saveApprovals(user, nextApprovals.map((item) => (item.id === updatedGrant.id ? updatedGrant : item)));
          await persistApprovalSummary(user, updatedGrant);
          return updatedGrant;
        }
      }
      const error = new Error("approval_id ausente");
      error.statusCode = 403;
      throw error;
    }
    const { approval, approvals } = await findApproval(user, id);
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
    if (approval.kind === "conversation_grant" || approval.kind === "global_grant") {
      if (!approvalAllowsAction(approval, normalizedAction, conversationId || approval.conversation_id)) {
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
      await saveApprovals(user, approvals.map((item) => (item.id === updatedGrant.id ? updatedGrant : item)));
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
    await saveApprovals(user, next);
    await persistApprovalSummary(user, updated);
    return updated;
  }

  async function handleApprovalsApi(req, res, url, user) {
    if (req.method === "GET" && url.pathname === "/api/approvals") {
      const approvals = await loadApprovals(user);
      sendJson(res, 200, {
        ok: true,
        items: approvals.map(serializeApproval)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/approvals") {
      const payload = await parseJsonBody(req);
      const approval = normalizeApprovalPayload(payload, user);
      await upsertApproval(user, approval);
      sendJson(res, 201, { ok: true, item: serializeApproval(approval) });
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

    const { approval, approvals } = await findApproval(user, approvalId);
    if (!approval) {
      sendJson(res, 404, { error: "approval nao encontrado" });
      return;
    }

    if (parts.length === 1 && req.method === "GET") {
      sendJson(res, 200, { ok: true, item: serializeApproval(approval) });
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
      await saveApprovals(user, approvals.map((item) => (item.id === next.id ? next : item)));
      await persistApprovalSummary(user, next);
      sendJson(res, 200, { ok: true, item: serializeApproval(next) });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  }

  return {
    handleApprovalsApi,
    normalizeApprovalAction,
    requireApprovedAction
  };
}
