export function createFilesystemModule({
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
  processPlatform,
  mimeTypes,
  attachmentDisposition,
  sendJson,
  parseJsonBody,
  ensureUserDirs,
  userWorkspaceDir,
  clampFsReadMaxBytes,
  requireApprovedAction
}) {
  function normalizeRelativePath(input) {
    return String(input || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .trim();
  }

  function workspacePath(user, input) {
    const root = userWorkspaceDir(user);
    const rel = normalizeRelativePath(input);
    const absolute = resolve(root, rel || ".");
    const back = relative(root, absolute);
    if (back.startsWith("..") || back.includes(`..${processPlatform === "win32" ? "\\" : "/"}`)) {
      throw new Error("Path escapes workspace root");
    }
    return { rel, absolute };
  }

  function entryTypeFromStats(stats) {
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  }

  async function handleFsApi(req, res, url, user) {
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
      const contentType = mimeTypes[extname(absolute).toLowerCase()] || "application/octet-stream";
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
      await requireApprovedAction(user, url.searchParams.get("approval_id"), "fs_delete", {
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

  return {
    entryTypeFromStats,
    handleFsApi,
    normalizeRelativePath,
    workspacePath
  };
}
