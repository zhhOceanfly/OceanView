import * as path from "path";
import { startServer } from "./server";

interface CliArgs {
  proto: string;
  git: string;
  branch: string;
  port: number;
  open: boolean;
  showGoogle: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    proto: process.cwd(),
    git: "",
    branch: "main",
    port: 3920,
    // 开发 watch 会反复重启进程；默认不弹浏览器，避免每次开新标签
    open: process.env.OCEANVIEW_DEV !== "1",
    showGoogle: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "-V" || a === "--version") args.version = true;
    else if (a === "--proto" || a === "-p") args.proto = path.resolve(argv[++i] || ".");
    else if (a === "--git" || a === "-g") args.git = argv[++i] || "";
    else if (a === "--branch" || a === "-b") args.branch = argv[++i] || "main";
    else if (a === "--port") args.port = Math.max(1, Number(argv[++i] || 3920) || 3920);
    else if (a === "--no-open") args.open = false;
    else if (a === "--open") args.open = true;
    else if (a === "--show-google") args.showGoogle = true;
    else if (!a.startsWith("-")) args.proto = path.resolve(a);
  }
  return args;
}

function printHelp(): void {
  console.log(`ProtoView Client CLI

Usage:
  oceanview [options] [dir]

Options:
  --proto, -p <dir>     Scan .proto under directory (default: cwd)
  --git, -g <url>       Use Git repo as proto source (clone to temp dir)
  --branch, -b <name>   Git branch (default: main)
  --port <n>            HTTP port (default: 3920)
  --no-open             Do not open browser (default in npm run dev:cli)
  --open                Open browser on start
  --show-google         Include google.* packages in tree
  -h, --help            Show help

Env:
  OCEANVIEW_EDITOR      Editor to open source (cursor / code / idea, or
                        template with {file} {line})

Examples:
  oceanview
  oceanview --proto ./api
  oceanview --git https://github.com/org/repo.git --branch main
  oceanview -V              # 打印版本
  OCEANVIEW_EDITOR=cursor oceanview
`);
}

function printVersion(): void {
  // 从发布包里的 package.json 读，保证与 npm 上的版本一致
  let version = "unknown";
  try {
    // dist/cli.js → ../package.json
    version = String(require("../package.json").version || "unknown");
  } catch {
    /* 读不到就保持 unknown */
  }
  console.log(version);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    printVersion();
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  const publicDir = process.env.OCEANVIEW_PUBLIC_DIR
    ? path.resolve(process.env.OCEANVIEW_PUBLIC_DIR)
    : path.join(__dirname, "..", "public");
  if (process.env.OCEANVIEW_DEV === "1") {
    console.log(`[oceanview] DEV publicDir=${publicDir}`);
  }
  await startServer({
    publicDir,
    workspaceRoot: args.proto,
    port: args.port,
    openBrowser: args.open,
    showGoogle: args.showGoogle,
    gitUrl: args.git,
    gitBranch: args.branch,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
