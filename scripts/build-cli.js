/**
 * Build @zhhoceanfly/oceanview CLI package:
 * 1) compile root TypeScript (shared core)
 * 2) compile packages/cli
 * 3) copy out/*.js → packages/cli/dist/core
 * 4) copy client/ → packages/cli/public
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cliRoot = path.join(root, "packages", "cli");
const outDir = path.join(root, "out");
const coreDest = path.join(cliRoot, "dist", "core");
const publicDest = path.join(cliRoot, "public");

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

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** packages/cli 是独立包，根目录 npm ci 不会装它的依赖；缺了 tsc 会报 TS2307 */
function missingCliDeps() {
  const required = ["ws", "@types/ws", "@grpc/grpc-js", "@grpc/proto-loader", "protobufjs"];
  return required.filter((name) => !fs.existsSync(path.join(cliRoot, "node_modules", ...name.split("/"))));
}

function ensureCliDeps() {
  const missing = missingCliDeps();
  if (!missing.length) return;
  console.warn(`[build-cli] packages/cli 缺少依赖：${missing.join(", ")}，自动安装…`);
  const hasLock = fs.existsSync(path.join(cliRoot, "package-lock.json"));
  const cmd = hasLock ? "npm ci --include=dev" : "npm install --include=dev";
  try {
    execSync(cmd, { cwd: cliRoot, stdio: "inherit" });
  } catch (error) {
    console.error(`[build-cli] 自动安装失败（${cmd}）：${error?.message || error}`);
    console.error("[build-cli] 请手动执行：npm ci --prefix packages/cli");
    process.exit(1);
  }
  const still = missingCliDeps();
  if (still.length) {
    console.error(`[build-cli] 安装后仍缺少：${still.join(", ")}`);
    console.error("[build-cli] 请手动执行：npm ci --prefix packages/cli");
    process.exit(1);
  }
}

ensureCliDeps();

/**
 * dist/core 里复制过去的是扩展的核心模块，它们会 require 第三方包
 * （xlsx / mysql2 / @grpc/grpc-js …）。这些包必须在 packages/cli 的
 * dependencies 里声明，否则用户 `npm i -g` 之后运行时必然 MODULE_NOT_FOUND。
 */
function assertCliDependencies() {
  const cliPkg = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"));
  const declared = new Set([
    ...Object.keys(cliPkg.dependencies || {}),
    ...Object.keys(cliPkg.optionalDependencies || {}),
  ]);
  const external = new Set();
  const builtin = new Set(require("module").builtinModules);
  for (const file of CORE_FILES) {
    const compiled = path.join(outDir, file);
    if (!fs.existsSync(compiled)) continue;
    const text = fs.readFileSync(compiled, "utf8");
    for (const match of text.matchAll(/require\("([^".][^"]*)"\)/g)) {
      const id = match[1];
      if (id.startsWith("node:")) continue;
      if (builtin.has(id) || builtin.has(id.split("/")[0])) continue;
      // 取包名（@scope/name 或 name）
      const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
      external.add(name);
    }
  }
  const missing = [...external].filter((name) => !declared.has(name)).sort();
  if (missing.length) {
    console.error(`[build-cli] packages/cli/package.json 缺少运行时依赖：${missing.join(", ")}`);
    console.error("[build-cli] 这些包会被 dist/core 的模块 require，不声明就会在用户机器上报 MODULE_NOT_FOUND。");
    console.error("[build-cli] 补到 packages/cli/package.json 的 dependencies 后重试。");
    process.exit(1);
  }
  console.log(`[build-cli] dependency check ok (${external.size} external modules)`);
}

console.log("[build-cli] compile extension src…");
execSync("npx tsc -p ./", { cwd: root, stdio: "inherit" });

console.log("[build-cli] compile packages/cli…");
rmrf(path.join(cliRoot, "dist"));
execSync("npx tsc -p ./", { cwd: cliRoot, stdio: "inherit" });

assertCliDependencies();

console.log("[build-cli] copy core modules…");
rmrf(coreDest);
fs.mkdirSync(coreDest, { recursive: true });
for (const file of CORE_FILES) {
  const src = path.join(outDir, file);
  if (!fs.existsSync(src)) {
    console.warn(`[build-cli] skip missing ${file}`);
    continue;
  }
  copyFile(src, path.join(coreDest, file));
  const map = `${src}.map`;
  if (fs.existsSync(map)) copyFile(map, path.join(coreDest, `${file}.map`));
}

console.log("[build-cli] copy client public…");
rmrf(publicDest);
copyDir(path.join(root, "client"), publicDest);

// Donate image optional for AI page
const mediaQr = path.join(root, "media", "donate-wechat.png");
if (fs.existsSync(mediaQr)) {
  copyFile(mediaQr, path.join(publicDest, "donate-wechat.png"));
}

console.log("[build-cli] done →", cliRoot);
