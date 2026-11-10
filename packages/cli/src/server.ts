import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { exec } from "child_process";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { materializeGhzUpload, materializeProtoUpload, ProtoUploadSession } from "./uploadProtoDir";

type ClientHostCtor = {
  new (options: {
    workspaceRoot: string;
    showGoogle?: boolean;
    initialSource?: { mode?: string; gitUrl?: string; gitBranch?: string; dirPath?: string };
    log?: (line: string) => void;
  }): {
    reload(syncGit?: boolean): Promise<void>;
    handleMessage(
      message: {
        type?: string;
        file?: string;
        line?: number;
        editor?: string;
        payload?: Record<string, unknown>;
      },
      send: (m: Record<string, unknown>) => void,
    ): Promise<void>;
    sourceLabel(): string;
  };
};

// Packaged next to dist/ as dist/core/* (copied by scripts/build-cli.js)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ClientHost } = require("./core/hostCore") as { ClientHost: ClientHostCtor };

export interface ServerOptions {
  publicDir: string;
  /** proto 扫描根（--proto） */
  protoRoot?: string;
  /** 工作区根：Excel / Docs / SQL / 环境文件 */
  workspaceRoot: string;
  port: number;
  openBrowser: boolean;
  showGoogle: boolean;
  gitUrl: string;
  gitBranch: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

export async function startServer(options: ServerOptions): Promise<void> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const protoRoot = path.resolve(options.protoRoot || options.workspaceRoot);
  const host = new ClientHost({
    // 工作区：Excel / Docs / SQL / 环境文件
    workspaceRoot,
    showGoogle: options.showGoogle,
    initialSource: options.gitUrl
      ? { mode: "git", gitUrl: options.gitUrl, gitBranch: options.gitBranch || "main" }
      // proto 扫描根与工作区可能不同（例如 --proto ./api）
      : { mode: "workspace", dirPath: protoRoot },
    log: (line) => console.log(`[oceanview] ${line}`),
  });

  console.log(`[oceanview] loading protos from ${options.gitUrl || protoRoot} …`);
  if (!options.gitUrl && protoRoot !== workspaceRoot) {
    console.log(`[oceanview] workspace (excel / docs / sql): ${workspaceRoot}`);
  }
  await host.reload(Boolean(options.gitUrl));

  const server = http.createServer((req, res) => {
    void serveStatic(options.publicDir, req, res);
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    // 单条消息上限。正常上传走分片（uploadProtoDirChunk），这里留足余量；
    // 不要设成无限大 —— 过大的单帧会让 ws 的 receiver 报错并断开这条连接。
    maxPayload: 64 * 1024 * 1024,
  });

  /** 进行中的分片上传会话（按 uploadId 区分） */
  const uploads = new Map<string, { session: ProtoUploadSession; at: number }>();

  /** 清理超时未完成的上传会话，避免临时目录泄漏 */
  function sweepUploads(): void {
    const now = Date.now();
    for (const [id, item] of uploads) {
      if (now - item.at < 5 * 60 * 1000) continue;
      uploads.delete(id);
      console.warn(`[oceanview] upload session expired: ${id}`);
    }
  }

  wss.on("connection", (socket: WebSocket) => {
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };
    // ws 的 'error' 必须监听：否则单帧超限 / 连接异常会以未捕获的 error 事件
    // 抛出，直接把整个 CLI 进程干掉（表现为 RangeError: Max payload size exceeded）。
    socket.on("error", (error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`[oceanview] websocket error: ${text}`);
      // 单帧超限时这条连接已经不可用，浏览器侧往往只看到「导入无反应」。
      // 这里尽量再推一条可操作提示（连接可能已半死，发送失败就忽略）。
      if (/max payload/i.test(text)) {
        try {
          socket.send(JSON.stringify({
            type: "toast",
            level: "err",
            text: "上传内容过大被拒绝。请刷新页面（Ctrl+F5）后重试；"
              + "或在「自定义源」里直接填写本机目录路径，CLI 会自己扫描，无需上传。",
          }));
        } catch { /* 连接已断开 */ }
      }
    });
    socket.on("message", (raw: RawData) => {
      void (async () => {
        try {
          const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Buffer.from(raw as ArrayBuffer).toString("utf8");
          const message = JSON.parse(text) as {
            type?: string;
            payload?: {
              name?: string;
              files?: Array<{ path: string; content?: string; base64?: string }>;
              base64?: string;
              uploadId?: string;
            };
          };
          // 分片上传：begin → chunk… → end。每片体积小，不会撞 maxPayload。
          if (message.type === "uploadBegin") {
            const payload = message.payload || {};
            const uploadId = String(payload.uploadId || "");
            if (!uploadId) {
              send({ type: "toast", level: "err", text: "缺少 uploadId" });
              return;
            }
            sweepUploads();
            const session = new ProtoUploadSession(payload.name);
            await session.begin();
            uploads.set(uploadId, { session, at: Date.now() });
            send({ type: "uploadAck", uploadId, stage: "begin" });
            return;
          }
          if (message.type === "uploadProtoDirChunk") {
            const payload = message.payload || {};
            const uploadId = String(payload.uploadId || "");
            const entry = uploads.get(uploadId);
            if (!entry) {
              send({ type: "toast", level: "err", text: "上传会话已失效，请重新选择目录" });
              return;
            }
            entry.at = Date.now();
            await entry.session.write(payload.files || []);
            send({ type: "uploadAck", uploadId, stage: "chunk" });
            return;
          }
          if (message.type === "uploadEnd") {
            const payload = message.payload || {};
            const uploadId = String(payload.uploadId || "");
            const entry = uploads.get(uploadId);
            if (!entry) {
              send({ type: "toast", level: "err", text: "上传会话已失效，请重新选择目录" });
              return;
            }
            uploads.delete(uploadId);
            const result = await entry.session.finish();
            if (!result.count) {
              send({ type: "toast", level: "err", text: "目录中未找到 .proto / Excel / 文档 / SQL 文件" });
              return;
            }
            send({
              type: "pickedProtoDir",
              path: result.dir,
              label: result.label,
              count: result.protoCount,
              fileCount: result.count,
            });
            return;
          }
          // 兼容旧客户端：整包上传（文件多时容易撞 maxPayload，仅作兜底）
          if (message.type === "uploadProtoDir") {
            const result = await materializeProtoUpload(message.payload || {});
            if (!result.count) {
              send({ type: "toast", level: "err", text: "目录中未找到 .proto / Excel / 文档 / SQL 文件" });
              return;
            }
            send({
              type: "pickedProtoDir",
              path: result.dir,
              label: result.label,
              // 提示里说清楚导入了什么，避免以为只有 proto
              count: result.protoCount,
              fileCount: result.count,
            });
            return;
          }
          // CLI 跑在本机：直接用服务端路径扫描，省掉「浏览器把文件读进内存再上传」这一大步。
          // 浏览器选完文件夹只能拿到文件内容（没有真实绝对路径），所以这条路仍保留作兜底。
          if (message.type === "scanProtoDir") {
            const dirPath = String((message.payload as { path?: string } | undefined)?.path || "").trim();
            if (!dirPath) {
              send({ type: "toast", level: "err", text: "请填写目录路径" });
              return;
            }
            const abs = path.resolve(dirPath);
            const stat = await fs.promises.stat(abs).catch(() => null);
            if (!stat || !stat.isDirectory()) {
              send({ type: "toast", level: "err", text: `目录不存在：${abs}` });
              return;
            }
            send({
              type: "pickedProtoDir",
              path: abs,
              label: path.basename(abs) || abs,
              count: null,
              local: true,
            });
            return;
          }
          if (message.type === "uploadGhzBinary") {
            const file = await materializeGhzUpload(message.payload || {});
            if (file) send({ type: "pickedGhzBinary", path: file });
            return;
          }
          await host.handleMessage(message, send);
        } catch (error) {
          send({
            type: "invokeResult",
            ok: false,
            status: "ERROR",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  // 进程级兜底：WebSocket receiver 抛出的错误（例如单帧超限）如果不能被
  // 局部捕获，会让整个 CLI 直接退出。这里记录下来但不退出，服务继续可用。
  process.on("uncaughtException", (error) => {
    console.warn(`[oceanview] uncaughtException (ignored to keep serving): ${error instanceof Error ? error.message : String(error)}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.warn(`[oceanview] unhandledRejection (ignored): ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  const url = `http://127.0.0.1:${options.port}/`;
  console.log(`[oceanview] ProtoView Client → ${url}`);
  console.log(`[oceanview] source: ${host.sourceLabel()}`);
  console.log("[oceanview] press Ctrl+C to stop");

  if (options.openBrowser) openUrl(url);
}

async function serveStatic(
  publicDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const filePath = path.normalize(path.join(publicDir, rel));
    if (!filePath.startsWith(path.normalize(publicDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    let data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    // 给 HTML 里的 script/link 加版本号，彻底绕开浏览器缓存。
    // 否则改了 client/*.js 后浏览器仍跑旧代码，会出现「服务端已修复、
    // 前端还在发旧协议」这种极难排查的现象（旧前端会把整个目录塞进一条消息）。
    if (ext === ".html") {
      const stamp = String(Date.now());
      data = Buffer.from(
        data.toString("utf8").replace(
          /(src|href)="(\.\/[^"?]+\.(?:js|css))"/g,
          (_all, attr, url) => `${attr}="${url}?v=${stamp}"`,
        ),
        "utf8",
      );
    }
    // 开发模式下静态资源一律不缓存
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

function openUrl(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? `start "" "${url}"`
      : platform === "darwin" ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (error) => {
    if (error) console.warn(`[oceanview] could not open browser: ${error.message}`);
  });
}
