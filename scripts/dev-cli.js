/**
 * CLI 开发模式：tsc watch + 同步 core + 直连仓库 client/，Node --watch 重启服务。
 *
 *   npm run dev:cli
 *   npm run dev:cli -- --proto ./api --port 3920
 *
 * 改 client/*.js|css|html → 浏览器刷新即可
 * 改 src/*.ts 或 packages/cli/src → 自动编译并重启服务
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cliRoot = path.join(root, "packages", "cli");
const outDir = path.join(root, "out");
const coreDest = path.join(cliRoot, "dist", "core");
const clientDir = path.join(root, "client");
const mediaQr = path.join(root, "media", "donate-wechat.png");

const CORE_FILES = [
  "hostCore.js",
  "catalog.js",
  "parser.js",
  "clientModel.js",
  "sourceCore.js",
  "codeSymbols.js",
  "callGraph.js",
  "excelIndex.js",
  "sqlIndex.js",
  "docIndex.js",
  "dbSession.js",
  "dbSchema.js",
  "gitChanges.js",
  "oceanMessages.js",
  "openEditor.js",
  "grpcInvoke.js",
  "decodeBytes.js",
  "httpInvoke.js",
  "sseInvoke.js",
  "wsInvoke.js",
  "invokeDispatch.js",
  "grpcStress.js",
  "meta.js",
];

const children = [];
let syncTimer = null;
/** server 重启去抖定时器（shutdown 也要能清理，所以提前声明） */
let restartTimer = null;

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function syncCore() {
  fs.mkdirSync(coreDest, { recursive: true });
  let n = 0;
  for (const file of CORE_FILES) {
    const src = path.join(outDir, file);
    if (!fs.existsSync(src)) continue;
    copyFile(src, path.join(coreDest, file));
    const map = `${src}.map`;
    if (fs.existsSync(map)) copyFile(map, path.join(coreDest, `${file}.map`));
    n += 1;
  }
  // 可选二维码放到 client 旁，开发时从 media 挂一份到 client（不污染 git）
  if (fs.existsSync(mediaQr)) {
    copyFile(mediaQr, path.join(clientDir, "donate-wechat.png"));
  }
  console.log(`[dev-cli] synced ${n} core modules → dist/core`);
  return n;
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    try {
      // 只在 dist/core 内容真的变化时才重启，避免 tsc 首轮编译等
      // 「mtime 变了但内容没变」的情况触发无意义的重启
      const changed = diffCore();
      if (!changed.length) return;
      syncCore();
      console.log(`[dev-cli] core changed (${changed.length}) → restarting server`);
      restartServer();
    } catch (error) {
      console.warn("[dev-cli] sync failed:", error.message || error);
    }
  }, 200);
}

/** 返回内容与 dist/core 不一致的模块名 */
function diffCore() {
  const changed = [];
  for (const file of CORE_FILES) {
    const src = path.join(outDir, file);
    const dest = path.join(coreDest, file);
    if (!fs.existsSync(src)) continue;
    let same = false;
    try {
      const a = fs.readFileSync(src);
      const b = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      same = Boolean(b) && a.equals(b);
    } catch {
      same = false;
    }
    if (!same) changed.push(file);
  }
  return changed;
}

function run(cmd, args, opts = {}) {
  const { shell = false, ...rest } = opts;
  const child = spawn(cmd, args, {
    stdio: "inherit",
    shell,
    ...rest,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.warn(`[dev-cli] ${cmd} ${args.join(" ")} exited ${code}`);
    }
  });
  return child;
}

function shutdown() {
  if (restartTimer) clearTimeout(restartTimer);
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[dev-cli] initial compile…");
// packages/cli 是独立包，根目录 npm ci 不会装它的依赖
(() => {
  const required = ["ws", "@types/ws", "@grpc/grpc-js", "@grpc/proto-loader", "protobufjs"];
  const missing = required.filter((name) => !fs.existsSync(path.join(cliRoot, "node_modules", ...name.split("/"))));
  if (!missing.length) return;
  console.error(`[dev-cli] packages/cli 缺少依赖：${missing.join(", ")}`);
  console.error("[dev-cli] 请先执行：npm ci --prefix packages/cli");
  process.exit(1);
})();
execSync("npx tsc -p ./", { cwd: root, stdio: "inherit" });
execSync("npx tsc -p ./", { cwd: cliRoot, stdio: "inherit" });
syncCore();

console.log("[dev-cli] watching TypeScript…");
run("npx", ["tsc", "-w", "-p", "./", "--preserveWatchOutput"], { cwd: root, shell: true });
run("npx", ["tsc", "-w", "-p", "./", "--preserveWatchOutput"], { cwd: cliRoot, shell: true });

/**
 * 监听 out/ 变化把编译产物同步到 dist/core。
 *
 * 不用 fs.watch({recursive:true})：Windows 上它本身也可能抛 EPERM，
 * 且和 syncCore 的写入互相干扰。改用「目录 mtime 轮询」，稳定且开销很小。
 */
const WATCH_FILES = CORE_FILES;
let lastStamp = "";
function statStamp() {
  const parts = [];
  for (const file of WATCH_FILES) {
    const full = path.join(outDir, file);
    try {
      const st = fs.statSync(full);
      parts.push(`${file}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${file}:-`);
    }
  }
  return parts.join("|");
}
lastStamp = statStamp();
setInterval(() => {
  const next = statStamp();
  if (next === lastStamp) return;
  lastStamp = next;
  scheduleSync();
}, 800);

let passthrough = process.argv.slice(2);
if (passthrough[0] === "--") passthrough = passthrough.slice(1);
const serverArgs = passthrough.length
  ? passthrough
  : ["--proto", process.cwd(), "--port", "3920"];

// 开发模式默认不自动开浏览器（每次重启都会再弹一个标签）
if (!serverArgs.includes("--open") && !serverArgs.includes("--no-open")) {
  serverArgs.push("--no-open");
}

const portArg = serverArgs.findIndex((a) => a === "--port");
const port = portArg >= 0 ? serverArgs[portArg + 1] : "3920";
console.log("[dev-cli] serving frontend from", clientDir);
console.log("[dev-cli] 改 client/ 后浏览器刷新即可；改 .ts 会自动编译并重启服务");
console.log(`[dev-cli] 请手动打开 http://127.0.0.1:${port}/ （默认不自动弹浏览器；需要时加 --open）`);

/**
 * 自己管理 server 子进程的启停，不用 `node --watch-path`。
 *
 * 原因：Windows 上 `--watch-path` 会递归监听 dist 目录，而 syncCore() 同时
 * 在往该目录复制文件，两者竞争会触发 `EPERM: operation not permitted, watch`，
 * 这个 error 事件没被处理就让 watch 进程整个退出（dev-cli 本身还活着，
 * 但服务没了，表现为 CLI 突然不可用）。
 */
let serverProc = null;

function startServer() {
  serverProc = spawn(
    "node",
    [path.join(cliRoot, "dist", "cli.js"), ...serverArgs],
    {
      stdio: "inherit",
      cwd: root,
      env: {
        ...process.env,
        OCEANVIEW_PUBLIC_DIR: clientDir,
        OCEANVIEW_DEV: "1",
      },
    },
  );
  serverProc.on("exit", (code, signal) => {
    if (signal) return;
    // 非 0 退出（比如端口占用）打印出来，别静默
    if (code) console.warn(`[dev-cli] server exited ${code}，1 秒后重启…`);
    if (code) setTimeout(startServer, 1000);
  });
  children.push(serverProc);
}

function restartServer() {
  // serverArgs 是 const，在它声明之前（初始 syncCore 阶段）访问会抛 TDZ，
  // 这里直接兜住：那时也不需要重启（server 还没起来）。
  try { void serverArgs; } catch { return; }
  if (restartTimer) clearTimeout(restartTimer);
  // 合并短时间内的多次触发（syncCore 一次会写多个文件）
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill("SIGTERM"); } catch { /* ignore */ }
      // 等端口释放再起，避免 EADDRINUSE
      setTimeout(startServer, 300);
      return;
    }
    startServer();
  }, 150);
}

console.log("[dev-cli] starting:", "oceanview", serverArgs.join(" "));
startServer();
