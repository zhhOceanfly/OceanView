import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface UploadedProtoFile {
  path: string;
  /** 文本内容（.proto / .md / .sql 等） */
  content?: string;
  /** 二进制内容的 base64（.xlsx / .xlsm / .xls / .docx，不能用文本读） */
  base64?: string;
}

/**
 * 浏览器上传时允许落到临时目录的资源类型。
 * 必须包含 Excel / Docs / SQL —— 用户选完目录后，ExcelView / DocsView / DbView
 * 都从同一个目录扫描；只传 .proto 会让那三个视图全空。
 */
const UPLOAD_EXTS = new Set([
  // proto
  ".proto",
  // Excel
  ".xlsx", ".xlsm", ".xls", ".csv",
  // Docs
  ".md", ".markdown", ".mdx", ".docx", ".txt", ".rst", ".adoc", ".html",
  // SQL
  ".sql",
]);

/** 这些是二进制格式，必须按 base64 传输，用 UTF-8 文本读会损坏文件 */
export function isBinaryUpload(name: string): boolean {
  const ext = path.extname(String(name || "")).toLowerCase();
  return BINARY_EXTS.has(ext);
}

const BINARY_EXTS = new Set([".xlsx", ".xlsm", ".xls", ".docx"]);

/** 该文件是否需要随目录一起上传 */
export function isUploadable(name: string): boolean {
  const ext = path.extname(String(name || "")).toLowerCase();
  return UPLOAD_EXTS.has(ext);
}

/** 将浏览器选中的目录树落到系统临时目录，返回绝对路径（目录名用所选文件夹名）。 */
export async function materializeProtoUpload(options: {
  name?: string;
  files?: UploadedProtoFile[];
}): Promise<{ dir: string; count: number; label: string; protoCount: number }> {
  const session = new ProtoUploadSession(options.name);
  await session.begin();
  await session.write(options.files || []);
  return session.finish();
}

/**
 * 分片上传会话。
 *
 * 为什么需要它：把整个目录（含 xlsx 的 base64）塞进一条 WebSocket 消息，
 * 很容易超过 ws 的 maxPayload，而且一条消息过大时 receiver 会直接报错断开、
 * 整个连接不可恢复。改成 begin → 多次 write → finish 的增量写盘：
 * 每片体积可控，服务端边收边落盘，内存也不会被整包撑爆。
 */
export class ProtoUploadSession {
  private readonly label: string;
  private readonly safeLabel: string;
  private root = "";
  private rootAbs = "";
  private readonly dirsMade = new Set<string>();
  private readonly jobs: Array<Promise<void>> = [];
  private count = 0;
  private protoCount = 0;

  constructor(name?: string) {
    this.label = String(name || "proto").trim() || "proto";
    this.safeLabel = this.label.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").slice(0, 64) || "proto";
  }

  public async begin(): Promise<void> {
    const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oceanview-dir-"));
    this.root = path.join(staging, this.safeLabel);
    await fs.promises.mkdir(this.root, { recursive: true });
    this.rootAbs = path.resolve(this.root);
    this.dirsMade.add(this.rootAbs);
  }

  /** 追加一批文件（可多次调用） */
  public async write(files: UploadedProtoFile[]): Promise<void> {
    const batch: Array<Promise<void>> = [];
    for (const file of files) {
      let relRaw = String(file?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
      // webkitdirectory 路径常带顶层文件夹名，去掉以免多嵌一层
      if (relRaw === this.label || relRaw.startsWith(`${this.label}/`)) {
        relRaw = relRaw.slice(this.label.length).replace(/^\/+/, "");
      }
      if (!relRaw || relRaw.includes("\0")) continue;
      const rel = path.normalize(relRaw);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      // 保留 proto 以及 excel / docs / sql：三个视图都从同一个目录扫描
      if (!isUploadable(rel)) continue;
      const dest = path.resolve(this.root, rel);
      if (!dest.startsWith(this.rootAbs + path.sep) && dest !== this.rootAbs) continue;
      // 目录只 mkdir 一次，文件写入并行
      const dir = path.dirname(dest);
      const mkdir = this.dirsMade.has(dir)
        ? Promise.resolve()
        : fs.promises.mkdir(dir, { recursive: true }).then(() => { this.dirsMade.add(dir); });
      // 二进制按 base64 还原，文本按 utf8 写入
      const bytes = typeof file.base64 === "string" && file.base64
        ? Buffer.from(file.base64, "base64")
        : Buffer.from(String(file.content ?? ""), "utf8");
      batch.push(mkdir.then(() => fs.promises.writeFile(dest, bytes)));
      this.count += 1;
      if (rel.toLowerCase().endsWith(".proto")) this.protoCount += 1;
    }
    await Promise.all(batch);
    this.jobs.push(...batch);
  }

  public async finish(): Promise<{ dir: string; count: number; label: string; protoCount: number }> {
    await Promise.all(this.jobs);
    return { dir: this.root, count: this.count, label: this.label, protoCount: this.protoCount };
  }
}

/** 将浏览器选中的 ghz 可执行文件落到临时目录。 */
export async function materializeGhzUpload(options: {
  name?: string;
  base64?: string;
}): Promise<string | undefined> {
  const name = path.basename(String(options.name || "ghz").trim() || "ghz");
  const b64 = String(options.base64 || "");
  if (!b64) return undefined;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oceanview-ghz-"));
  const dest = path.join(dir, name);
  await fs.promises.writeFile(dest, Buffer.from(b64, "base64"));
  if (process.platform !== "win32") {
    await fs.promises.chmod(dest, 0o755);
  }
  return dest;
}
