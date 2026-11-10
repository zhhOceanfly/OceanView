/**
 * 打包并发布到 Open VSX（Cursor 扩展源）。
 *
 * 两种认证方式：
 *  A. Trusted Publishing（推荐，CI 用）：仓库 + workflow 在 open-vsx.org 注册后，
 *     workflow 用 OIDC 换短期 token，无需任何 Secret。要求 ovsx >= 1.1.0、Node >= 22。
 *  B. Access Token（本机 / 首次发布必须走这条）：OVSX_PAT=ovsxat_xxx
 *
 * 用法：
 *   node scripts/openvsx-publish.js namespace            # 首次创建命名空间（需 PAT）
 *   node scripts/openvsx-publish.js publish              # 有 OVSX_PAT 用 PAT，否则用 OIDC
 *   node scripts/openvsx-publish.js publish-trusted      # 强制 OIDC（无 PAT 时失败即报错）
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const token = (process.env.OVSX_PAT || "").trim();
const ns = process.env.OVSX_NAMESPACE || pkg.publisher || "zoceanfly";
const cmd = process.argv[2] || "publish";

/** OIDC 只在 GitHub Actions 等能提供 ID token 的环境可用 */
const hasOidc =
  Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL) &&
  Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

const trusted = cmd === "publish-trusted" || (cmd === "publish" && !token && hasOidc);

if (cmd === "publish-trusted" && !hasOidc) {
  console.error(`[openvsx] 当前环境拿不到 OIDC ID token，无法使用 Trusted Publishing。
请在 GitHub Actions 中运行（job 需 permissions.id-token: write），
或本机改用 OVSX_PAT：export OVSX_PAT=ovsxat_你的token`);
  process.exit(1);
}

if (cmd === "namespace" && !token) {
  console.error(`[openvsx] 创建命名空间必须用 Access Token（OIDC 不适用）。
请先设置 OVSX_PAT：https://open-vsx.org/user-settings/tokens`);
  process.exit(1);
}

if (!token && !trusted) {
  console.error(`
[openvsx] 缺少认证方式。

Trusted Publishing（CI）：
  workflow 需要 permissions.id-token: write，且仓库/workflow 已在
  https://open-vsx.org/user-settings/trusted-publishers 注册。

Access Token（本机）：
  bash:        export OVSX_PAT=ovsxat_你的token
  PowerShell:  $env:OVSX_PAT="ovsxat_你的token"

Token 来源：https://open-vsx.org/user-settings/tokens
（需先签署 Eclipse Open VSX Publisher Agreement）
`);
  process.exit(1);
}

/**
 * ovsx 1.4 内置的 vsce 4 依赖 parse5（纯 ESM），Node < 22.12 默认不允许
 * require() 加载 ESM，会报 ERR_REQUIRE_ESM。这里在旧 Node 上自动加
 * --experimental-require-module，避免用户必须换 Node 版本。
 */
function ovsxCommand(args) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const needsFlag = major < 22 || (major === 22 && minor < 12);
  // 直接指向本地 bin，避免 npx 再解析一次（npx 也会走同一个 node）
  const bin = path.join(root, "node_modules", "ovsx", "bin", "ovsx");
  const invocation = fs.existsSync(bin) ? `"${process.execPath}"${needsFlag ? " --experimental-require-module" : ""} "${bin}"` : `npx ovsx${needsFlag ? " --node-options=--experimental-require-module" : ""}`;
  return `${invocation} ${args}`;
}

function run(command) {
  const shown = token ? command.replace(token, "***") : command;
  console.log(`[openvsx] ${shown}`);
  execSync(command, { cwd: root, stdio: "inherit", env: process.env, shell: true });
}

if (cmd === "namespace") {
  // 命名空间只需创建一次；已存在时会报错，可忽略
  run(ovsxCommand(`create-namespace ${ns} -p "${token}"`));
  console.log(`[openvsx] 命名空间「${ns}」已请求创建（若已存在可忽略报错）。`);
  process.exit(0);
}

const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) {
  console.error(`[openvsx] 找不到 ${path.basename(vsix)}，请先执行：npm run package`);
  process.exit(1);
}

// 显式传 token 时 ovsx 会优先用 PAT；否则走 OIDC 交换
if (token) {
  run(ovsxCommand(`publish "${vsix}" -p "${token}"`));
} else {
  run(ovsxCommand(`publish "${vsix}" --trusted-publishing`));
}

console.log(`[openvsx] 已发布 ${path.basename(vsix)} → Open VSX（Cursor 搜索可能需等待索引）。`);
console.log(`          https://open-vsx.org/extension/${ns}/${pkg.name}`);
