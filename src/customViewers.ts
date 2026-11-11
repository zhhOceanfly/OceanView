import * as path from "path";
import * as vscode from "vscode";
import { docTextFromBuffer } from "./docIndex";
import { parseWorkbookBuffer, WorkbookSheetData } from "./excelIndex";
import { openWorkingExcel } from "./excelDiffCommand";

/**
 * Excel / Docs 的自定义编辑器（Custom Editor）。
 * 关键点：
 * 1. 直接用 VS Code 的 document 内容（支持 git: 只读旧版本），不依赖目录扫描；
 * 2. Excel 单元格双击进入编辑，回车 / 失焦提交，Ctrl+S 或「保存」按钮落盘，
 *    保存后标签页不再显示未保存圆点，标题栏给出「已保存 时间」提示；
 * 3. 从 Git 侧栏点开 Excel 只打开当前文件，**不自动**切到差异对比，
 *    需要对比时手动点顶部「差异对比」。
 */

async function readDocumentBytes(document: vscode.CustomDocument & { uri: vscode.Uri }): Promise<Buffer> {
  return (await readUriBytes(document.uri)) || Buffer.alloc(0);
}
void readDocumentBytes;

class ExcelViewEditorProvider implements vscode.CustomEditorProvider {
  public static readonly viewType = "oceanview.excelViewer";

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      ExcelViewEditorProvider.viewType,
      new ExcelViewEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ExcelDocument>>();
  public readonly onDidChangeCustomDocument = this.changed.event;
  /** 当前打开过的编辑器面板，用于「与 git HEAD 对比」按钮 */
  public static panels = new Map<string, vscode.WebviewPanel>();

  public async openCustomDocument(uri: vscode.Uri): Promise<ExcelDocument> {
    const bytes = (await readUriBytes(uri)) || Buffer.alloc(0);
    return new ExcelDocument(uri, bytes);
  }

  public async saveCustomDocument(document: ExcelDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    await document.save();
    // 保存完成给 webview 回一条明确反馈（顶部「已保存 时间」），否则用户不知道有没有写盘
    const panel = ExcelViewEditorProvider.panels.get(document.uri.toString());
    if (panel) {
      void panel.webview.postMessage({ type: "saved", at: document.savedAt || Date.now() });
    }
  }

  public async saveCustomDocumentAs(document: ExcelDocument, destination: vscode.Uri): Promise<void> {
    await document.saveAs(destination);
  }

  public async revertCustomDocument(document: ExcelDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    await document.revert();
  }

  public async backupCustomDocument(
    document: ExcelDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await this.saveCustomDocument(document, new vscode.CancellationTokenSource().token);
    return { id: context.destination.toString(), delete: () => undefined };
  }

  public async resolveCustomEditor(document: ExcelDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };
    // Git 侧栏点开 Excel 时，VS Code 会把它当内置 diff 打开（二进制只剩一行提示），
    // 或者用 git: 历史版本 URI 建一个只读自定义编辑器。
    // 这里既不渲染历史版本、也不自动跳差异页：关掉 diff，把当前标签换成
    // **工作区最新文件**的 ExcelView，可直接双击编辑、Ctrl+S 保存。
    if (document.uri.scheme !== "file" || isOpenInDiff(document.uri)) {
      await rehomeToWorking(document.uri.fsPath, panel);
      return;
    }
    const render = () => {
      panel.webview.html = renderExcelHtml(document);
    };
    render();
    ExcelViewEditorProvider.panels.set(document.uri.toString(), panel);
    panel.onDidDispose(() => ExcelViewEditorProvider.panels.delete(document.uri.toString()));
    panel.webview.onDidReceiveMessage(async (message: {
      type?: string;
      sheet?: string;
      row?: number;
      col?: number;
      value?: string;
    }) => {
      if (!message) return;
      if (message.type === "diffHead") {
        await vscode.commands.executeCommand("oceanview.excelDiff", document.uri);
        return;
      }
      if (message.type === "openClient") {
        await openInClient("excel", document.uri.fsPath);
        return;
      }
      if (message.type === "selectSheet") {
        const name = String(message.sheet || "");
        if (name) {
          sheetMemory.set(document.uri.toString(), name);
          render();
        }
        return;
      }
      if (message.type === "editCell") {
        const row = Number(message.row);
        const col = Number(message.col);
        if (!Number.isFinite(row) || !Number.isFinite(col)) return;
        const entry = document.editCell(String(message.sheet || ""), row, col, String(message.value ?? ""));
        if (!entry) {
          panel.webview.postMessage({ type: "cellSaved", ok: true, row, col, dirty: document.isDirty() });
          return;
        }
        // 通知 VS Code 文档已修改：标签出现未保存圆点，Ctrl+S 才会走 saveCustomDocument
        this.changed.fire({
          document,
          undo: () => {
            document.undoEdit();
            render();
          },
          redo: () => {
            document.redoEdit();
            render();
          },
        });
        panel.webview.postMessage({
          type: "cellSaved",
          ok: true,
          row,
          col,
          dirty: document.isDirty(),
          editCount: document.editCount(),
        });
        return;
      }
      if (message.type === "saveNow") {
        // 走 VS Code 的保存链路，标签的未保存圆点才会一起清掉；
        // 万一当前活动编辑器不是这个面板（焦点被别处抢走），直接落盘兜底。
        await vscode.commands.executeCommand("workbench.action.files.save");
        if (document.isDirty()) {
          await this.saveCustomDocument(document, new vscode.CancellationTokenSource().token);
        }
        void panel.webview.postMessage({ type: "saved", at: document.savedAt || Date.now() });
        return;
      }
    });
  }
}

class DocsViewEditorProvider implements vscode.CustomEditorProvider {
  public static readonly viewType = "oceanview.docsViewer";

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      DocsViewEditorProvider.viewType,
      new DocsViewEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DocsDocument>>();
  public readonly onDidChangeCustomDocument = this.changed.event;

  public async openCustomDocument(uri: vscode.Uri): Promise<DocsDocument> {
    const text = await readDocsText(uri);
    return new DocsDocument(uri, text);
  }
  public async saveCustomDocument(document: DocsDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    await document.save();
  }

  public async saveCustomDocumentAs(document: DocsDocument, destination: vscode.Uri): Promise<void> {
    await document.saveAs(destination);
  }

  public async revertCustomDocument(document: DocsDocument, cancellation: vscode.CancellationToken): Promise<void> {
    void cancellation;
    document.revert();
  }

  public async backupCustomDocument(
    document: DocsDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    void document;
    return { id: context.destination.toString(), delete: () => undefined };
  }

  public async resolveCustomEditor(document: DocsDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = renderDocsHtml(document);
    panel.webview.onDidReceiveMessage(async (message: { type?: string; text?: string }) => {
      if (!message) return;
      if (message.type === "openClient") {
        await openInClient("docs", document.uri.fsPath);
        return;
      }
      if (message.type === "save") {
        document.setText(String(message.text ?? ""));
        await document.save();
        void vscode.window.showInformationMessage("已保存");
      }
    });
  }
}

/** 从任意 URI 读文档文本：file 直读，git: 走 git 扩展取历史内容 */
async function readDocsText(uri: vscode.Uri): Promise<string> {
  const bytes = await readUriBytes(uri);
  if (bytes) return docTextFromBuffer(bytes, uri.fsPath || uri.path);
  return "";
}

/**
 * 拿 URI 的原始字节。
 * 注意：git: 这类 URI 的 fsPath 指向的是「当前工作区文件」，直接 fs 读会拿到新内容，
 * 所以非 file scheme 必须先走 git 扩展取历史版本，不能先 fs。
 */
async function readUriBytes(uri: vscode.Uri): Promise<Buffer | null> {
  const fs = await import("fs/promises");
  if (uri.scheme === "file" || uri.scheme === "vscode-remote") {
    try {
      return await fs.readFile(uri.fsPath);
    } catch {
      return null;
    }
  }
  // 1) git 扩展：用 ref + 相对路径取历史内容
  const fromGit = await readGitBytes(uri);
  if (fromGit) return fromGit;
  // 2) 其他只读 scheme：退回 VS Code 文档（文本类文件有效）
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return Buffer.from(doc.getText(), "utf8");
  } catch {
    return null;
  }
}

/**
 * 读取 git 历史版本里的原始字节。
 * 注意两点：
 * 1. 不能用 vscode.git 的 repo.show()，它返回字符串，xlsx/docx 这类二进制会被破坏
 *    （表现为只解析出一行或读到空文档）；
 * 2. git: URI 的 fsPath 有时不可靠，路径优先从 URI 的 query 里取，再退回 fsPath。
 */
async function readGitBytes(uri: vscode.Uri): Promise<Buffer | null> {
  // 路径候选：query.path > uri.path（去掉前导 /）> fsPath
  const candidates: string[] = [];
  let ref = "";
  try {
    const query = uri.query ? JSON.parse(uri.query) : null;
    ref = String(query?.ref || query?.refName || "");
    if (query?.path) candidates.push(String(query.path).replace(/^\/+/, ""));
  } catch { /* query 不是 JSON */ }
  if (uri.path) candidates.push(uri.path.replace(/^\/+/, ""));
  if (uri.fsPath) candidates.push(uri.fsPath);

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs/promises");
  const run = promisify(execFile);

  const show = async (cwd: string, relative: string, revision: string): Promise<Buffer | null> => {
    try {
      const { stdout } = await run("git", ["show", `${revision}:${relative}`], {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer" as unknown as "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return Buffer.isBuffer(stdout) && stdout.length ? stdout : null;
    } catch {
      return null;
    }
  };

  // 1) 从文件所在目录往上找仓库根，用相对路径取内容
  const startDir = (() => {
    const guess = candidates.find((item) => path.isAbsolute(item)) || uri.fsPath || "";
    return guess ? path.dirname(path.resolve(guess)) : "";
  })();
  if (startDir) {
    let dir = startDir;
    for (let i = 0; i < 12; i += 1) {
      const hasGit = await fs.access(path.join(dir, ".git")).then(() => true, () => false);
      if (hasGit) {
        const full = path.resolve(candidates.find((item) => path.isAbsolute(item)) || uri.fsPath);
        const relative = path.relative(dir, full).split(path.sep).join("/");
        const bytes = await show(dir, relative, ref || "HEAD");
        if (bytes) return bytes;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 2) 退回到 git 扩展给出的仓库根 + 相对路径
  try {
    const gitExt = vscode.extensions.getExtension("vscode.git");
    if (gitExt) {
      const api = await gitExt.activate();
      const repos = api?.getAPI?.(1)?.repositories || [];
      const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
      for (const repo of repos) {
        const root = String(repo.rootUri?.fsPath || "");
        if (!root) continue;
        const bytes = await show(root, relative, ref || "HEAD");
        if (bytes) return bytes;
      }
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 打开 Client 并定位到该文件对应的视图 */
async function openInClient(view: "excel" | "docs", file: string): Promise<void> {
  const command = view === "excel" ? "oceanview.openExcelView" : "oceanview.openDocsView";
  // 让快速入口命令拿到目标文件：临时把 URI 记在命令参数里
  await vscode.commands.executeCommand(command, vscode.Uri.file(file));
}

/**
 * 该 URI 是否正被 VS Code 当作 diff 的一侧打开（Git 侧点击就是这种情况）。
 * 左右两侧都算，因为两侧都会进 resolveCustomEditor。
 */
function isOpenInDiff(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
    if (!(tab.input instanceof vscode.TabInputTextDiff)) return false;
    return tab.input.original.toString() === key || tab.input.modified.toString() === key;
  }));
}

/**
 * 把「Git 历史版本 / diff 一侧」的自定义编辑器换成工作区文件的正常编辑器。
 * 在同一个标签列打开并关闭原面板，视觉上就是「点了哪一侧都只是打开最新文件」。
 */
async function rehomeToWorking(fsPath: string, panel: vscode.WebviewPanel): Promise<void> {
  const column = panel.viewColumn || vscode.ViewColumn.Active;
  panel.dispose();
  await openWorkingExcel(fsPath, column);
}

export { openInClient };

/** 一次单元格改动：before/after 用于撤销与重做 */
interface CellEdit {
  sheet: string;
  row: number;
  col: number;
  before: string;
  after: string;
}

/** Excel 文档模型：持有内存中的工作表，改动后写回磁盘 */
class ExcelDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  private buffer: Buffer;
  private sheetNames: string[] = [];
  public get sheetNameList(): string[] { return this.sheetNames.slice(); }
  private sheets = new Map<string, WorkbookSheetData>();
  /** 最近一次成功写盘的时间戳（ms），用于顶部「已保存」提示 */
  public savedAt = 0;
  /** 未保存的单元格改动，支撑撤销 / 重做与脏状态 */
  private undoStack: CellEdit[] = [];
  private redoStack: CellEdit[] = [];

  public constructor(uri: vscode.Uri, buffer: Buffer) {
    this.uri = uri;
    this.buffer = buffer;
    this.load(buffer);
  }

  private load(buffer: Buffer): void {
    const parsed = parseWorkbookBuffer(buffer);
    this.sheets.clear();
    this.sheetNames = parsed.map((sheet) => sheet.name);
    for (const sheet of parsed) this.sheets.set(sheet.name, sheet);
  }

  public names(): string[] {
    return this.sheetNames.slice();
  }

  public sheet(name: string): WorkbookSheetData | undefined {
    return this.sheets.get(name) || this.sheets.get(this.sheetNames[0]);
  }

  public isDirty(): boolean {
    return this.undoStack.length > 0;
  }

  /** 未保存的改动数量 */
  public editCount(): number {
    return this.undoStack.length;
  }

  /** 未保存改动涉及的单元格（行、列），用于重新渲染后仍高亮 */
  public editedCells(): Array<{ row: number; col: number }> {
    return this.undoStack.map((entry) => ({ row: entry.row, col: entry.col }));
  }

  /** 底层写入：只改内存，不记撤销栈。行号是 Excel 的 1 基行号 */
  private setCell(sheetName: string, row: number, col: number, value: string): boolean {
    const sheet = this.sheet(sheetName);
    if (!sheet) return false;
    const rowIndex = row - 1 - (sheet.rowOffset || 0);
    if (rowIndex < 0 || rowIndex >= sheet.rows.length) return false;
    while (sheet.rows[rowIndex].length <= col) sheet.rows[rowIndex].push("");
    sheet.rows[rowIndex][col] = value;
    return true;
  }

  /** 读取某单元格当前值 */
  public cellValue(sheetName: string, row: number, col: number): string {
    const sheet = this.sheet(sheetName);
    if (!sheet) return "";
    const rowIndex = row - 1 - (sheet.rowOffset || 0);
    const line = sheet.rows[rowIndex];
    return line ? (line[col] ?? "") : "";
  }

  /** 用户改动一个单元格：记入撤销栈并标脏；值没变则返回 null */
  public editCell(sheetName: string, row: number, col: number, value: string): CellEdit | null {
    const before = this.cellValue(sheetName, row, col);
    if (before === value) return null;
    if (!this.setCell(sheetName, row, col, value)) return null;
    const entry: CellEdit = { sheet: sheetName, row, col, before, after: value };
    this.undoStack.push(entry);
    this.redoStack.length = 0;
    return entry;
  }

  public undoEdit(): CellEdit | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.setCell(entry.sheet, entry.row, entry.col, entry.before);
    this.redoStack.push(entry);
    return entry;
  }

  public redoEdit(): CellEdit | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.setCell(entry.sheet, entry.row, entry.col, entry.after);
    this.undoStack.push(entry);
    return entry;
  }

  /** 按扩展名决定写回格式，避免把 .csv/.xls 覆盖成 xlsx 二进制 */
  private bookType(): "xlsx" | "xlsm" | "xls" | "csv" {
    const ext = path.extname(this.uri.fsPath || this.uri.path).toLowerCase();
    if (ext === ".csv") return "csv";
    if (ext === ".xls") return "xls";
    if (ext === ".xlsm") return "xlsm";
    return "xlsx";
  }

  public async save(): Promise<void> {
    if (!this.undoStack.length) return;
    const XLSX = await import("xlsx");
    const book = XLSX.read(this.buffer, { type: "buffer", cellDates: true, cellNF: true });
    for (const name of this.sheetNames) {
      const sheet = this.sheets.get(name);
      const ws = book.Sheets[name];
      if (!sheet || !ws) continue;
      for (let r = 0; r < sheet.rows.length; r += 1) {
        const absoluteRow = r + (sheet.rowOffset || 0);
        const cells = sheet.rows[r] || [];
        for (let c = 0; c < cells.length; c += 1) {
          const addr = XLSX.utils.encode_cell({ r: absoluteRow, c });
          const text = cells[c] ?? "";
          if (!text) delete ws[addr];
          else ws[addr] = { t: "s", v: text };
        }
      }
    }
    const bookType = this.bookType();
    const out = XLSX.write(book, { type: "buffer", bookType });
    // CSV 输出会带 UTF-8 BOM，某些工具会把首个表头读成 \ufeffname，这里去掉
    const bytes = bookType === "csv"
      ? Buffer.from(out.toString("utf8").replace(/^\uFEFF/, ""), "utf8")
      : (out as Buffer);
    const fs = await import("fs/promises");
    await fs.writeFile(this.uri.fsPath, bytes);
    this.buffer = bytes;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.savedAt = Date.now();
  }

  public async saveAs(destination: vscode.Uri): Promise<void> {
    const fs = await import("fs/promises");
    await fs.writeFile(destination.fsPath, this.buffer);
  }

  /** 丢弃改动并重新从磁盘读回，保证撤销/回退后内存与文件一致 */
  public async revert(): Promise<void> {
    try {
      const fs = await import("fs/promises");
      this.buffer = await fs.readFile(this.uri.fsPath);
    } catch { /* 读不到就退回上次保存的内容 */ }
    this.load(this.buffer);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  public dispose(): void { /* 无资源需要释放 */ }
}

/** Docs 文档模型：文本可直接改并保存（docx 只读） */
class DocsDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  private text: string;
  private original: string;
  private dirty = false;

  public constructor(uri: vscode.Uri, text: string) {
    this.uri = uri;
    this.text = text;
    this.original = text;
  }

  public getText(): string {
    return this.text;
  }

  public setText(text: string): void {
    this.text = text;
    this.dirty = text !== this.original;
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  public async save(): Promise<void> {
    if (!this.dirty) return;
    const fs = await import("fs/promises");
    await fs.writeFile(this.uri.fsPath, this.text, "utf8");
    this.original = this.text;
    this.dirty = false;
  }

  public async saveAs(destination: vscode.Uri): Promise<void> {
    const fs = await import("fs/promises");
    await fs.writeFile(destination.fsPath, this.text, "utf8");
  }

  public revert(): void {
    this.text = this.original;
    this.dirty = false;
  }

  public dispose(): void { /* 无资源需要释放 */ }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function baseStyles(): string {
  return `
  :root { color-scheme: light dark; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; min-height: 0;
    font: 13px/1.5 var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap;
    border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background);
    flex: 0 0 auto; }
  .bar strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34%; }
  .bar .spacer { flex: 1 1 auto; }
  button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { opacity: .9; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .tabs { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border); overflow: hidden; }
  .sheet-tabs { flex: 1 1 auto; min-width: 0; display: flex; gap: 4px; flex-wrap: nowrap; overflow-x: auto; }
  .tabs button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .find-nav { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; margin-left: auto;
    padding-left: 8px; border-left: 1px solid var(--vscode-panel-border); }
  .find-nav input { width: 140px; height: 26px; border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 0 8px; font-size: 12px; }
  .find-nav button { min-width: 26px; height: 26px; padding: 0 6px; }
  .find-nav button:disabled { opacity: .4; }
  .find-count { min-width: 3.2em; text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace); }
  .sheet-match { margin-left: 4px; padding: 0 5px; border-radius: 999px; font-size: 10px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  td.is-find-hit { background: rgba(59, 130, 246, .14); }
  td.is-find-current { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px;
    background: rgba(59, 130, 246, .32) !important; scroll-margin: 72px 96px; }
  mark.find-mark { background: rgba(59, 130, 246, .28); color: inherit; border-radius: 2px; }
  mark.find-mark.current { outline: 2px solid var(--vscode-focusBorder); background: rgba(59, 130, 246, .45); }
  /* 关键：内容区自己滚动，滚轮不会失效 */
  .wrap { flex: 1 1 auto; min-height: 0; overflow: auto; }
  table { border-collapse: collapse; font: 12px/1.4 var(--vscode-editor-font-family, monospace); }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; white-space: pre;
    vertical-align: top; min-width: 60px; }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; z-index: 1; }
  td.rowno, th.rowno { color: var(--vscode-descriptionForeground); text-align: right; position: sticky;
    left: 0; background: var(--vscode-editorWidget-background); z-index: 1; }
  td.editable:focus { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-editor-selectionBackground); }
  .diff-cell { background: rgba(240, 180, 0, .32); }
  pre { margin: 0; padding: 10px 14px; white-space: pre-wrap; word-break: break-word;
    font: 12.5px/1.65 var(--vscode-editor-font-family, monospace); }
  textarea { width: 100%; height: 100%; box-sizing: border-box; border: 0; resize: none; padding: 12px 14px;
    background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font: 12.5px/1.65 var(--vscode-editor-font-family, monospace); outline: none; }
  .empty { padding: 24px; color: var(--vscode-descriptionForeground); }
  .readonly-tip { color: var(--vscode-descriptionForeground); font-size: 11px; }
  `;
}

function renderExcelHtml(document: ExcelDocument): string {
  const names = document.names();
  // 记住当前 sheet：重新渲染时用上一次的选择
  const activeName = lastSheet(document.uri.toString()) || names[0] || "";
  const sheet = document.sheet(activeName);
  const readonly = document.uri.scheme !== "file";
  const workbook = names.map((name) => {
    const item = document.sheet(name);
    return {
      name,
      rowOffset: item?.rowOffset || 0,
      rows: (item?.rows || []).map((row) => row.map((cell) => String(cell ?? ""))),
    };
  });
  const tabs = names.map((name) => (
    `<button type="button" data-sheet="${escapeHtml(name)}"${name === activeName ? ' class="active"' : ""}><span>${escapeHtml(name)}</span></button>`
  )).join("");
  const width = Math.max(...(sheet?.rows || []).map((row) => row.length), 1);
  const head = sheet
    ? `<tr><th class="rowno">#</th>${Array.from({ length: width }, (_, i) => `<th>${columnLetter(i)}</th>`).join("")}</tr>`
    : "";
  // 重新渲染（切 Sheet）后仍要保留未保存高亮，所以先把改动单元格收集起来
  const editedKeys = new Set(document.editedCells().map((item) => `${item.row}:${item.col}`));
  const body = sheet
    ? sheet.rows.map((row, index) => {
      const excelRow = index + 1 + (sheet.rowOffset || 0);
      const cells = Array.from({ length: width }, (_, c) => {
        const value = row[c] ?? "";
        const cls = readonly ? "" : " editable";
        const dirty = !readonly && editedKeys.has(`${excelRow}:${c}`) ? " dirty-cell" : "";
        // 不加 contenteditable：单击只选中，双击才进入编辑，避免误改
        return `<td class="${cls.trim()}${dirty}" data-row="${excelRow}" data-col="${c}">${escapeHtml(value)}</td>`;
      }).join("");
      return `<tr><td class="rowno">${excelRow}</td>${cells}</tr>`;
    }).join("")
    : "";
  const content = sheet
    ? `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
    : `<div class="empty">这个文件里没有可显示的 Sheet。</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <style>${baseStyles()}
      .bar .save-state { font-size: 11px; color: var(--vscode-descriptionForeground); }
      .bar .save-state.dirty { color: var(--vscode-editorWarning-foreground, #d18616); font-weight: 600; }
      .bar .save-state.done { color: var(--vscode-testing-iconPassed, #3fb950); font-weight: 600; }
      button[disabled] { opacity: .45; cursor: default; }
      td.editable { cursor: cell; }
      td.editable.is-selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
      td.editable[contenteditable="true"] { background: var(--vscode-editor-selectionBackground); outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
      td.editable.dirty-cell { background: rgba(209, 134, 22, .22); }
    </style></head><body>
    <div class="bar">
      <strong>${escapeHtml(path.basename(document.uri.fsPath || document.uri.path))}</strong>
      <span class="hint">${sheet ? `${sheet.rows.length} 行` : ""}${readonly ? " · 只读（Git 历史版本）" : " · 双击单元格编辑，回车确认，Ctrl+S 保存"}</span>
      <span class="spacer"></span>
      <span class="save-state" id="saveState"></span>
      ${readonly ? "" : '<button type="button" data-save disabled title="保存到磁盘（Ctrl+S）">保存</button>'}
      ${readonly ? "" : '<button type="button" data-diff-head title="与 git HEAD 版本对比，高亮变化的单元格">与 git 对比</button>'}
      <button class="primary" type="button" data-open-client>在 ExcelView Client 中编辑</button>
    </div>
    <div class="tabs">
      <div class="sheet-tabs" id="sheetTabs">${tabs}</div>
      <div class="find-nav" title="在当前工作簿中查找（可跨 Sheet）">
        <input id="findInput" type="search" placeholder="查找… Ctrl+F" autocomplete="off" spellcheck="false" />
        <button type="button" id="findClear" title="清空查找">✕</button>
        <button type="button" id="findPrev" title="上一处" disabled>▲</button>
        <span class="find-count" id="findCount">0 / 0</span>
        <button type="button" id="findNext" title="下一处" disabled>▼</button>
      </div>
    </div>
    <div class="wrap" id="tableWrap">${content}</div>
    <script>
      const vscode = (() => {
        try { return acquireVsCodeApi(); } catch (e) { return { postMessage: () => {}, getState: () => ({}), setState: () => {} }; }
      })();
      const uriKey = ${JSON.stringify(document.uri.toString())};
      const readonly = ${readonly ? "true" : "false"};
      const workbook = ${JSON.stringify(workbook)};
      const state = vscode.getState() || {};
      state.sheet = state.sheet || ${JSON.stringify(activeName)};
      state.find = state.find || { query: "", matches: [], index: -1 };
      vscode.setState(state);

      // ===== 保存状态提示 =====
      const saveBtn = document.querySelector("[data-save]");
      const saveStateEl = document.getElementById("saveState");
      let dirtyCount = ${document.editCount()};
      const dirtyCells = new Set();
      for (const cell of document.querySelectorAll("td.dirty-cell")) {
        dirtyCells.add(cell.getAttribute("data-row") + ":" + cell.getAttribute("data-col"));
      }
      function paintSaveState(kind, text) {
        if (!saveStateEl) return;
        saveStateEl.className = "save-state" + (kind ? " " + kind : "");
        saveStateEl.textContent = text || "";
      }
      function paintDirty(count) {
        dirtyCount = Number(count) || 0;
        if (saveBtn) {
          saveBtn.disabled = dirtyCount === 0;
          saveBtn.textContent = dirtyCount ? "保存 (" + dirtyCount + ")" : "保存";
        }
        paintSaveState(dirtyCount ? "dirty" : "", dirtyCount ? "未保存 " + dirtyCount + " 处修改" : "");
      }
      paintDirty(dirtyCount);

      function markDirtyCell(cell) {
        if (!cell) return;
        dirtyCells.add(cell.getAttribute("data-row") + ":" + cell.getAttribute("data-col"));
        cell.classList.add("dirty-cell");
      }

      // 单元格：单击选中，双击才进入编辑；回车 / 失焦提交，Esc 还原
      let editing = null;
      let selected = null;

      function selectCell(cell) {
        if (selected === cell) return;
        if (selected) selected.classList.remove("is-selected");
        selected = cell;
        if (cell) cell.classList.add("is-selected");
      }
      function beginEdit(cell) {
        if (!cell || readonly) return;
        selectCell(cell);
        if (cell.getAttribute("contenteditable") === "true") return;
        editing = { cell, before: cell.textContent || "" };
        cell.setAttribute("contenteditable", "true");
        cell.setAttribute("spellcheck", "false");
        cell.focus();
        // 光标落到末尾，避免双击后内容被整段选中导致误删
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      function endEdit(commit) {
        const current = editing;
        if (!current) return;
        editing = null;
        const cell = current.cell;
        const value = cell.textContent || "";
        cell.removeAttribute("contenteditable");
        if (!commit) cell.textContent = current.before;
        if (!commit || value === current.before) return;
        markDirtyCell(cell);
        vscode.postMessage({
          type: "editCell",
          sheet: state.sheet,
          row: Number(cell.getAttribute("data-row")),
          col: Number(cell.getAttribute("data-col")),
          value,
        });
      }

      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-open-client]")) {
          vscode.postMessage({ type: "openClient" });
          return;
        }
        if (event.target.closest("[data-diff-head]")) {
          vscode.postMessage({ type: "diffHead" });
          return;
        }
        if (event.target.closest("[data-save]")) {
          endEdit(true);
          vscode.postMessage({ type: "saveNow" });
          return;
        }
        const tab = event.target.closest("[data-sheet]");
        if (tab) {
          endEdit(true);
          state.sheet = tab.getAttribute("data-sheet") || "";
          vscode.setState(state);
          vscode.postMessage({ type: "selectSheet", sheet: state.sheet });
          return;
        }
        // 点到表格外面就收起选中
        const cell = event.target.closest("td.editable");
        if (!cell) {
          selectCell(null);
          return;
        }
        if (editing && editing.cell !== cell) endEdit(true);
        selectCell(cell);
      });
      document.addEventListener("dblclick", (event) => {
        const cell = event.target.closest("td.editable");
        if (!cell) return;
        event.preventDefault();
        beginEdit(cell);
      });
      // ===== 表内查找（跨 Sheet） =====
      const findInput = document.getElementById("findInput");
      const findCount = document.getElementById("findCount");
      const findPrev = document.getElementById("findPrev");
      const findNext = document.getElementById("findNext");
      const tableWrap = document.getElementById("tableWrap");
      function collectMatches(query) {
        const needle = String(query || "").trim().toLowerCase();
        const out = [];
        if (!needle) return out;
        for (const sheet of workbook) {
          for (let r = 0; r < sheet.rows.length; r++) {
            const row = sheet.rows[r] || [];
            for (let c = 0; c < row.length; c++) {
              const text = String(row[c] || "").toLowerCase();
              if (!text.includes(needle)) continue;
              out.push({ sheet: sheet.name, row: sheet.rowOffset + r + 1, col: c });
            }
          }
        }
        return out;
      }
      function paintFindCount() {
        const total = (state.find.matches || []).length;
        const index = Number(state.find.index);
        if (findCount) findCount.textContent = total ? ((index >= 0 ? index + 1 : 1) + " / " + total) : "0 / 0";
        if (findPrev) findPrev.disabled = !total;
        if (findNext) findNext.disabled = !total;
        const counts = {};
        for (const hit of state.find.matches || []) counts[hit.sheet] = (counts[hit.sheet] || 0) + 1;
        for (const btn of document.querySelectorAll("[data-sheet]")) {
          const name = btn.getAttribute("data-sheet") || "";
          let badge = btn.querySelector(".sheet-match");
          const n = counts[name] || 0;
          if (!n) { badge?.remove(); continue; }
          if (!badge) {
            badge = document.createElement("span");
            badge.className = "sheet-match";
            btn.appendChild(badge);
          }
          badge.textContent = String(n);
        }
      }
      function scrollCellIntoView(cell) {
        if (!cell || !tableWrap) return;
        const row = cell.closest("tr");
        const table = cell.closest("table");
        if (!row || !table) {
          cell.scrollIntoView({ block: "center", inline: "center" });
          return;
        }
        const headH = table.tHead ? table.tHead.offsetHeight : 0;
        let y = headH;
        const body = table.tBodies && table.tBodies[0];
        if (body) {
          for (const tr of body.rows) {
            if (tr === row) break;
            y += tr.offsetHeight || 0;
          }
        }
        let x = 0;
        for (const td of row.cells) {
          if (td === cell) break;
          x += td.offsetWidth || 0;
        }
        const viewH = Math.max(1, tableWrap.clientHeight - headH);
        const viewW = Math.max(1, tableWrap.clientWidth);
        tableWrap.scrollTop = Math.max(0, Math.min(y - headH - viewH * 0.3, tableWrap.scrollHeight - tableWrap.clientHeight));
        tableWrap.scrollLeft = Math.max(0, Math.min(x - viewW * 0.3, tableWrap.scrollWidth - tableWrap.clientWidth));
        const box = tableWrap.getBoundingClientRect();
        const rect = cell.getBoundingClientRect();
        const visible = rect.top >= box.top + headH - 2 && rect.bottom <= box.bottom + 2
          && rect.left >= box.left - 2 && rect.right <= box.right + 2;
        if (!visible) cell.scrollIntoView({ block: "center", inline: "center" });
      }
      function paintFindHits() {
        for (const cell of document.querySelectorAll("td.is-find-hit, td.is-find-current")) {
          cell.classList.remove("is-find-hit", "is-find-current");
        }
        const matches = state.find.matches || [];
        const current = matches[state.find.index];
        for (const hit of matches) {
          if (hit.sheet !== state.sheet) continue;
          const cell = document.querySelector('td[data-row="' + hit.row + '"][data-col="' + hit.col + '"]');
          if (!cell) continue;
          cell.classList.add("is-find-hit");
        }
        if (current && current.sheet === state.sheet) {
          const cell = document.querySelector('td[data-row="' + current.row + '"][data-col="' + current.col + '"]');
          if (cell) {
            cell.classList.add("is-find-current");
            selectCell(cell.classList.contains("editable") ? cell : selected);
            if (cell.classList.contains("editable")) selectCell(cell);
            requestAnimationFrame(() => {
              scrollCellIntoView(cell);
              setTimeout(() => scrollCellIntoView(cell), 60);
              setTimeout(() => scrollCellIntoView(cell), 180);
            });
          }
        }
        paintFindCount();
      }
      function gotoFind(delta) {
        const matches = state.find.matches || [];
        if (!matches.length) return;
        const total = matches.length;
        let index = Number(state.find.index);
        if (!Number.isFinite(index) || index < 0) index = delta > 0 ? -1 : 0;
        index = (index + delta + total) % total;
        state.find.index = index;
        const hit = matches[index];
        vscode.setState(state);
        paintFindCount();
        if (hit.sheet !== state.sheet) {
          state.pendingFocus = { row: hit.row, col: hit.col };
          state.sheet = hit.sheet;
          vscode.setState(state);
          vscode.postMessage({ type: "selectSheet", sheet: hit.sheet });
          return;
        }
        paintFindHits();
      }
      function runFind(query, keepIndex) {
        const q = String(query || "").trim();
        state.find.query = q;
        if (!q) {
          state.find.matches = [];
          state.find.index = -1;
          vscode.setState(state);
          if (findInput) findInput.value = "";
          paintFindHits();
          return;
        }
        const matches = collectMatches(q);
        const prev = keepIndex ? Number(state.find.index) : -1;
        state.find.matches = matches;
        state.find.index = matches.length
          ? (prev >= 0 && prev < matches.length ? prev : 0)
          : -1;
        vscode.setState(state);
        if (findInput && findInput.value !== q) findInput.value = q;
        if (!matches.length) {
          paintFindHits();
          return;
        }
        const hit = matches[state.find.index];
        if (hit.sheet !== state.sheet) {
          state.pendingFocus = { row: hit.row, col: hit.col };
          state.sheet = hit.sheet;
          vscode.setState(state);
          vscode.postMessage({ type: "selectSheet", sheet: hit.sheet });
          return;
        }
        paintFindHits();
      }
      if (findInput) {
        findInput.value = state.find.query || "";
        let findTimer = 0;
        findInput.addEventListener("input", () => {
          window.clearTimeout(findTimer);
          findTimer = window.setTimeout(() => runFind(findInput.value, false), 200);
        });
        findInput.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            runFind("", false);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const q = String(findInput.value || "").trim();
            if (!q) { runFind("", false); return; }
            if (state.find.query === q && (state.find.matches || []).length) {
              gotoFind(event.shiftKey ? -1 : 1);
              return;
            }
            runFind(q, false);
          }
        });
      }
      document.getElementById("findClear")?.addEventListener("click", () => {
        runFind("", false);
        findInput?.focus();
      });
      findPrev?.addEventListener("click", () => gotoFind(-1));
      findNext?.addEventListener("click", () => gotoFind(1));
      // 切 Sheet 后恢复定位
      if (state.pendingFocus) {
        const pending = state.pendingFocus;
        delete state.pendingFocus;
        vscode.setState(state);
        requestAnimationFrame(() => {
          const cell = document.querySelector('td[data-row="' + pending.row + '"][data-col="' + pending.col + '"]');
          if (cell && cell.classList.contains("editable")) selectCell(cell);
          paintFindHits();
        });
      } else {
        paintFindHits();
      }

      document.addEventListener("keydown", (event) => {
        // 全局 Ctrl+S：任何位置都能存（先提交正在编辑的单元格）
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          endEdit(true);
          vscode.postMessage({ type: "saveNow" });
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          findInput?.focus();
          findInput?.select();
          return;
        }
        // 没在编辑时的键盘导航：方向键移动选中，回车 / F2 进入编辑
        if (!editing) {
          if (event.target === findInput) return;
          const cell = selected;
          if (!cell) return;
          if (event.key === "Enter" || event.key === "F2") {
            event.preventDefault();
            beginEdit(cell);
            return;
          }
          const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
          if (step) {
            event.preventDefault();
            const row = Number(cell.getAttribute("data-row")) + step[0];
            const col = Number(cell.getAttribute("data-col")) + step[1];
            const next = document.querySelector(
              'td.editable[data-row="' + row + '"][data-col="' + col + '"]',
            );
            if (next) {
              selectCell(next);
              scrollCellIntoView(next);
            }
          }
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            beginEdit(cell);
            cell.textContent = "";
            endEdit(true);
          }
          return;
        }
        const cell = editing.cell;
        if (event.key === "Enter") {
          event.preventDefault();
          const before = cell.getAttribute("data-row");
          endEdit(true);
          // 回车后下移一格，和 Excel 一致
          const next = document.querySelector(
            'td.editable[data-row="' + (Number(before) + 1) + '"][data-col="' + cell.getAttribute("data-col") + '"]',
          );
          if (next) selectCell(next);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          const col = Number(cell.getAttribute("data-col"));
          const row = cell.getAttribute("data-row");
          endEdit(true);
          const next = document.querySelector(
            'td.editable[data-row="' + row + '"][data-col="' + (col + (event.shiftKey ? -1 : 1)) + '"]',
          );
          if (next) selectCell(next);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          endEdit(false);
        }
      });
      document.addEventListener("focusout", (event) => {
        if (!editing) return;
        if (event.target === editing.cell) endEdit(true);
      });
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (data?.type === "cellSaved") {
          if (!data.ok) {
            console.warn("保存单元格失败");
            return;
          }
          paintDirty(data.editCount ?? dirtyCount);
          return;
        }
        if (data?.type === "saved") {
          dirtyCells.clear();
          for (const cell of document.querySelectorAll("td.dirty-cell")) cell.classList.remove("dirty-cell");
          paintDirty(0);
          const at = data.at ? new Date(data.at) : new Date();
          const text = at.toLocaleTimeString("zh-CN", { hour12: false });
          paintSaveState("done", "已保存 " + text);
          setTimeout(() => {
            if (dirtyCount === 0 && saveStateEl?.classList.contains("done")) paintSaveState("", "");
          }, 4000);
          return;
        }
      });
      // 滚轮直达内容区；按住右键 + 滚轮 = 横向滚动
      const tableWrapEl = document.querySelector(".wrap");
      let rightPan = false;
      let rightScrolled = false;
      tableWrapEl?.addEventListener("mousedown", (e) => {
        if (e.button === 2) { rightPan = true; rightScrolled = false; }
      });
      window.addEventListener("mouseup", (e) => { if (e.button === 2) rightPan = false; });
      tableWrapEl?.addEventListener("mouseleave", () => { rightPan = false; });
      tableWrapEl?.addEventListener("contextmenu", (e) => {
        if (rightScrolled) { e.preventDefault(); rightScrolled = false; }
      });
      tableWrapEl?.addEventListener("wheel", (e) => {
        e.stopPropagation();
        const holdRight = rightPan || (e.buttons & 2) === 2;
        if (!holdRight) return;
        e.preventDefault();
        rightScrolled = true;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        tableWrapEl.scrollLeft += delta;
      }, { passive: false });
      void uriKey;
      void readonly;
    </script>
  </body></html>`;
}

const sheetMemory = new Map<string, string>();
function lastSheet(key: string): string {
  return sheetMemory.get(key) || "";
}

function columnLetter(index: number): string {
  let n = Number(index) || 0;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** 单个版本（Git 历史 或 工作区）的只读表格；git 侧额外给「与 git 对比」入口 */
function renderVersionHtml(document: ExcelDocument, label: string): string {
  const names = document.sheetNameList;
  const activeName = lastSheet(document.uri.toString()) || names[0] || "";
  const sheet = document.sheet(activeName);
  const tabs = names.map((name) => (
    `<button type="button" data-sheet="${escapeHtml(name)}"${name === activeName ? ' class="active"' : ""}>${escapeHtml(name)}</button>`
  )).join("");
  const width = Math.max(...(sheet?.rows || []).map((row) => row.length), 1);
  const head = sheet
    ? `<tr><th class="rowno">#</th>${Array.from({ length: width }, (_, i) => `<th>${columnLetter(i)}</th>`).join("")}</tr>`
    : "";
  const body = sheet
    ? sheet.rows.map((row, index) => {
      const excelRow = index + 1 + (sheet.rowOffset || 0);
      const cells = Array.from({ length: width }, (_, c) => `<td>${escapeHtml(row[c] ?? "")}</td>`).join("");
      return `<tr><td class="rowno">${excelRow}</td>${cells}</tr>`;
    }).join("")
    : "";
  const content = sheet
    ? `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
    : `<div class="empty">这个文件里没有可显示的 Sheet。</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <style>${baseStyles()}</style></head><body>
    <div class="bar">
      <strong>${escapeHtml(path.basename(document.uri.fsPath || document.uri.path))}</strong>
      <span class="hint">${label} · 只读</span>
      <span class="spacer"></span>
      <button type="button" data-diff-head title="打开单元格级差异对比">与 git 对比</button>
      <button class="primary" type="button" data-open-client>在 ExcelView Client 中编辑</button>
    </div>
    <div class="tabs">${tabs}</div>
    <div class="wrap">${content}</div>
    <script>
      const vscode = (() => {
        try { return acquireVsCodeApi(); } catch (e) { return { postMessage: () => {} }; }
      })();
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-open-client]")) {
          vscode.postMessage({ type: "openClient" });
          return;
        }
        if (event.target.closest("[data-diff-head]")) {
          vscode.postMessage({ type: "diffHead" });
          return;
        }
      });
    </script>
  </body></html>`;
}

/** 极简 Markdown → HTML：标题 / 列表 / 表格 / 代码块 / 引用 / 强调，够文档预览用 */
function markdownToHtml(text: string): string {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listType = "";
  let tableBuf: string[] = [];

  const inline = (raw: string): string => {
    let s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return s;
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = "";
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.filter((row) => !/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(row));
    const cellsOf = (row: string) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
    if (rows.length) {
      const head = cellsOf(rows[0]).map((cell) => `<th>${inline(cell)}</th>`).join("");
      const body = rows.slice(1).map((row) => `<tr>${cellsOf(row).map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    }
    tableBuf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      closeList();
      tableBuf.push(line);
      continue;
    }
    flushTable();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  flushTable();
  closeList();
  return out.join("\n");
}

function renderDocsHtml(document: DocsDocument): string {
  const name = path.basename(document.uri.fsPath || document.uri.path);
  // docx 和 git 历史版本只读；md / markdown / mdx 与普通文本可阅读、可编辑、可分栏
  const binary = /\.docx$/i.test(document.uri.path);
  const readonly = document.uri.scheme !== "file" || binary;
  const isMarkdown = /\.(md|markdown|mdx|docx)$/i.test(document.uri.path);
  const text = document.getText();
  const tip = readonly ? "只读预览" : "阅读 / 编辑 / 分栏 · Ctrl+S 保存";
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <style>${baseStyles()}
      .doc-body { max-width: 860px; margin: 0 auto; padding: 22px 28px 60px;
        font: 14px/1.75 var(--vscode-font-family); color: var(--vscode-foreground); }
      .doc-body h1 { font-size: 1.7em; margin: 1.1em 0 .5em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .3em; }
      .doc-body h2 { font-size: 1.4em; margin: 1em 0 .45em; }
      .doc-body h3 { font-size: 1.18em; margin: .9em 0 .4em; }
      .doc-body h4, .doc-body h5, .doc-body h6 { font-size: 1em; margin: .8em 0 .35em; }
      .doc-body p { margin: .55em 0; }
      .doc-body ul, .doc-body ol { margin: .5em 0 .5em 1.4em; padding: 0; }
      .doc-body li { margin: .18em 0; }
      .doc-body blockquote { margin: .6em 0; padding: .2em .9em; border-left: 3px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground); }
      .doc-body code { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em;
        background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: .1em .35em; }
      .doc-body pre { background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 10px 12px;
        overflow: auto; white-space: pre; }
      .doc-body pre code { background: none; padding: 0; }
      .doc-body table { border-collapse: collapse; margin: .7em 0; font-size: .95em; }
      .doc-body th, .doc-body td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
      .doc-body hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 1.2em 0; }
      .doc-body a { color: var(--vscode-textLink-foreground); }
      .modes { display: flex; gap: 4px; }
      .modes button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
      #stage { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
      #stage.single { grid-template-columns: 1fr; }
      #stage > * { min-width: 0; min-height: 0; }
      #stage > #previewWrap { border-right: 1px solid var(--vscode-panel-border); }
      #stage.single > #previewWrap { border-right: 0; }
      #editor { width: 100%; height: 100%; box-sizing: border-box; border: 0; resize: none;
        padding: 12px 14px; background: var(--vscode-editor-background); color: var(--vscode-foreground);
        font: 12.5px/1.7 var(--vscode-editor-font-family, monospace); outline: none; }
      .hidden { display: none !important; }
    </style></head><body>
    <div class="bar">
      <strong>${escapeHtml(name)}</strong>
      <span class="hint">${tip}</span>
      <span class="spacer"></span>
      ${readonly ? "" : `<div class="modes">
            <button type="button" data-mode="preview">阅读</button>
            <button type="button" data-mode="edit">编辑</button>
            <button type="button" data-mode="split">分栏</button>
          </div>`}
      <div class="find-nav" title="在当前文档中查找">
        <input id="findInput" type="search" placeholder="查找… Ctrl+F" autocomplete="off" spellcheck="false" />
        <button type="button" id="findClear" title="清空查找">✕</button>
        <button type="button" id="findPrev" title="上一处" disabled>▲</button>
        <span class="find-count" id="findCount">0 / 0</span>
        <button type="button" id="findNext" title="下一处" disabled>▼</button>
      </div>
      <button class="primary" type="button" data-open-client>在 DocsView Client 中编辑</button>
    </div>
    <div id="stage" class="single">
      <div class="wrap" id="previewWrap"><div class="doc-body" id="preview"></div></div>
      <textarea id="editor" spellcheck="false" class="hidden"></textarea>
    </div>
    <script>
      const vscode = (() => {
        try { return acquireVsCodeApi(); } catch (e) { return { postMessage: () => {}, getState: () => ({}), setState: () => {} }; }
      })();
      const isMarkdown = ${isMarkdown ? "true" : "false"};
      const readonly = ${readonly ? "true" : "false"};
      const previewEl = document.getElementById("preview");
      const previewWrap = document.getElementById("previewWrap");
      const editorEl = document.getElementById("editor");
      const stage = document.getElementById("stage");
      const findInput = document.getElementById("findInput");
      const findCount = document.getElementById("findCount");
      const findPrev = document.getElementById("findPrev");
      const findNext = document.getElementById("findNext");
      let text = ${JSON.stringify(text)};
      let findHits = [];
      let findIndex = -1;
      let findQuery = "";
      editorEl.value = text;
      function escapeHtml(v) {
        return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      function inline(raw) {
        let s = escapeHtml(raw);
        s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
        s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[^*])\\*([^*]+)\\*/g, "$1<em>$2</em>");
        s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
        s = s.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img alt="$1" src="$2" />');
        s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
        return s;
      }
      function render(src) {
        const lines = String(src || "").split("\\n");
        const out = [];
        let inCode = false, code = [], list = "", table = [];
        const closeList = () => { if (list) { out.push("</" + list + ">"); list = ""; } };
        const flushTable = () => {
          if (!table.length) return;
          const rows = table.filter((r) => !/^\\s*\\|?[\\s:-]+\\|[\\s:|-]*$/.test(r));
          const cellsOf = (r) => r.replace(/^\\s*\\|/, "").replace(/\\|\\s*$/, "").split("|").map((c) => c.trim());
          if (rows.length) {
            const head = cellsOf(rows[0]).map((c) => "<th>" + inline(c) + "</th>").join("");
            const body = rows.slice(1).map((r) => "<tr>" + cellsOf(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("");
            out.push("<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>");
          }
          table = [];
        };
        for (const line of lines) {
          if (/^\\s*\`\`\`/.test(line)) {
            if (inCode) { out.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>"); code = []; inCode = false; }
            else { closeList(); inCode = true; }
            continue;
          }
          if (inCode) { code.push(line); continue; }
          if (/^\\s*\\|/.test(line)) { closeList(); table.push(line); continue; }
          flushTable();
          if (!line.trim()) { closeList(); continue; }
          const h = /^(#{1,6})\\s+(.*)$/.exec(line);
          if (h) { closeList(); out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); continue; }
          if (/^\\s*([-*_])\\1{2,}\\s*$/.test(line)) { closeList(); out.push("<hr />"); continue; }
          const q = /^\\s*>\\s?(.*)$/.exec(line);
          if (q) { closeList(); out.push("<blockquote>" + inline(q[1]) + "</blockquote>"); continue; }
          const b = /^\\s*[-*+]\\s+(.*)$/.exec(line);
          if (b) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(b[1]) + "</li>"); continue; }
          const o = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
          if (o) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(o[1]) + "</li>"); continue; }
          closeList();
          out.push("<p>" + inline(line) + "</p>");
        }
        if (inCode && code.length) out.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>");
        flushTable();
        closeList();
        return out.join("\\n");
      }
      function paint() {
        previewEl.innerHTML = isMarkdown ? render(text) : "<pre>" + escapeHtml(text) + "</pre>";
      }
      function setMode(mode) {
        const next = readonly ? "preview" : mode;
        for (const btn of document.querySelectorAll("[data-mode]")) btn.classList.toggle("active", btn.getAttribute("data-mode") === next);
        previewWrap.classList.toggle("hidden", next === "edit");
        editorEl.classList.toggle("hidden", next === "preview");
        stage.classList.toggle("single", next !== "split");
        if (next !== "edit") paint();
      }
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-open-client]")) { vscode.postMessage({ type: "openClient" }); return; }
        const btn = event.target.closest("[data-mode]");
        if (btn) setMode(btn.getAttribute("data-mode"));
      });
      editorEl.addEventListener("input", () => {
        text = editorEl.value;
        if (stage.classList.contains("single") === false) paint();
      });
      function sourceText() {
        return editorEl.classList.contains("hidden") ? text : editorEl.value;
      }
      function paintFindCount() {
        const total = findHits.length;
        if (findCount) findCount.textContent = total ? ((findIndex >= 0 ? findIndex + 1 : 1) + " / " + total) : "0 / 0";
        if (findPrev) findPrev.disabled = !total;
        if (findNext) findNext.disabled = !total;
      }
      function revealFind(pos) {
        if (pos == null || pos < 0 || !findQuery) return;
        const src = sourceText();
        const line = src.slice(0, pos).split("\\n").length;
        if (!editorEl.classList.contains("hidden")) {
          editorEl.focus();
          editorEl.selectionStart = pos;
          editorEl.selectionEnd = pos + findQuery.length;
          editorEl.scrollTop = Math.max(0, (line - 3) * 22);
          return;
        }
        paint();
        const needle = findQuery.toLowerCase();
        const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
        let node, nth = 0, target = null;
        while ((node = walker.nextNode())) {
          const value = String(node.nodeValue || "");
          let from = 0;
          while (true) {
            const at = value.toLowerCase().indexOf(needle, from);
            if (at < 0) break;
            if (nth === findIndex) {
              try {
                const range = document.createRange();
                range.setStart(node, at);
                range.setEnd(node, at + findQuery.length);
                const mark = document.createElement("mark");
                mark.className = "find-mark current";
                range.surroundContents(mark);
                target = mark;
              } catch (e) {
                target = node.parentElement;
              }
              nth += 1;
              break;
            }
            nth += 1;
            from = at + Math.max(1, findQuery.length);
          }
          if (target) break;
        }
        if (target && previewWrap) {
          const box = previewWrap.getBoundingClientRect();
          const rect = target.getBoundingClientRect();
          previewWrap.scrollTop = Math.max(0, previewWrap.scrollTop + (rect.top - box.top) - box.height * 0.3);
          try { target.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* ignore */ }
        }
      }
      function runFind(query, dir) {
        findQuery = String(query || "").trim();
        if (!findQuery) {
          findHits = [];
          findIndex = -1;
          if (findInput) findInput.value = "";
          paintFindCount();
          paint();
          return;
        }
        const hay = sourceText().toLowerCase();
        const needle = findQuery.toLowerCase();
        const hits = [];
        let at = hay.indexOf(needle);
        while (at >= 0) {
          hits.push(at);
          at = hay.indexOf(needle, at + Math.max(1, needle.length));
        }
        findHits = hits;
        if (!hits.length) {
          findIndex = -1;
          paintFindCount();
          return;
        }
        if (!dir) {
          if (findIndex < 0 || findIndex >= hits.length) findIndex = 0;
        } else {
          if (findIndex < 0) findIndex = dir > 0 ? -1 : 0;
          findIndex = (findIndex + dir + hits.length) % hits.length;
        }
        paintFindCount();
        revealFind(hits[findIndex]);
      }
      let findTimer = 0;
      findInput?.addEventListener("input", () => {
        window.clearTimeout(findTimer);
        findTimer = window.setTimeout(() => runFind(findInput.value, 0), 200);
      });
      findInput?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); runFind("", 0); return; }
        if (event.key === "Enter") {
          event.preventDefault();
          const q = String(findInput.value || "").trim();
          if (!q) { runFind("", 0); return; }
          if (findQuery === q && findHits.length) runFind(q, event.shiftKey ? -1 : 1);
          else runFind(q, 0);
        }
      });
      document.getElementById("findClear")?.addEventListener("click", () => { runFind("", 0); findInput?.focus(); });
      findPrev?.addEventListener("click", () => runFind(findQuery || findInput?.value || "", -1));
      findNext?.addEventListener("click", () => runFind(findQuery || findInput?.value || "", 1));
      paintFindCount();
      document.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (readonly) return;
          vscode.postMessage({ type: "save", text: editorEl.value });
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          findInput?.focus();
          findInput?.select();
        }
      });
      setMode(readonly ? "preview" : (isMarkdown ? "split" : "preview"));
      for (const el of [previewWrap, editorEl]) el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    </script>
  </body></html>`;
}

export function registerCustomViewers(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    ExcelViewEditorProvider.register(context),
    DocsViewEditorProvider.register(context),
  );
}
