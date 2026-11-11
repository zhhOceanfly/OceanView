# OceanView 打包与发布

本文说明如何打包、发布 **VS Code Marketplace**、**Open VSX（Cursor）** 以及 **npm CLI（`@zhhoceanfly/oceanview`）**。日常使用说明见 [README.md](README.md)。

要求：**Node.js 18+**（推荐 **20.x**；Node 22 下全局 `@vscode/vsce@4` 可能报错）。

## 本地脚本一览

在仓库根目录：

| 脚本 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run compile` | 编译扩展 TypeScript → `out/` |
| `npm run watch` | 监听编译 |
| `npm run package` | 编译并打出 `oceanview-x.y.z.vsix` |
| `npm run package:precheck` | 预览将打进 VSIX 的文件 |
| `npm run package:fresh` | 删除旧 vsix 后重新打包 |
| `npm run clean:vsix` | 删除根目录下所有 `.vsix` |
| `npm run publish` | 发布到 VS Code Marketplace（需已 login） |
| `npm run publish:patch` / `publish:minor` | 升版本并发布到 Marketplace |
| `npm run openvsx:namespace` | 在 Open VSX 创建 publisher 命名空间（首次） |
| `npm run publish:openvsx` | 打 VSIX 并发布到 Open VSX |
| `npm run build:cli` | 构建 npm 包 `@zhhoceanfly/oceanview` |
| `npm run dev:cli` | CLI 开发模式：tsc watch + 直连 `client/`，改代码自动重启 |
| `npm run publish:cli` | 构建并 `npm publish` CLI 包 |

本地调试扩展：按 **F5**（「运行 OceanView」）打开 Extension Development Host。  
若本机已从商店安装过 OceanView（同 ID `zoceanfly.oceanview`），会与开发版抢激活。`.vscode/launch.json` 使用 `--disable-extensions`，调试窗口里只加载本仓库开发版，主窗口商店版不受影响。仍异常时：扩展面板暂时 **禁用** OceanView 后再 F5。

`packages/**` 已写入 [.vscodeignore](.vscodeignore)，打 VSIX 时不会打进 CLI 产物。

## 发布到 VS Code Marketplace

1. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建 Publisher（本扩展 `publisher` 为 `zoceanfly`）  
   管理页 URL 形如：`https://marketplace.visualstudio.com/manage/publishers/zoceanfly`  
   确认登录的 **Microsoft 账号** 就是拥有该 Publisher 的账号。
2. **方式 A（推荐，无需 PAT）**：先打包，再在管理页网页上传：

```bash
npm run package
# 得到 oceanview-x.y.z.vsix → 管理页 → 上传新版本
```

3. **方式 B（`vsce` + Azure DevOps PAT）**：PAT 必须由「拥有 publisher 的同一个 Microsoft 账号」创建。

#### 创建正确的 PAT

1. 用**无痕窗口**打开 https://dev.azure.com → 登录，确认头像/邮箱是 Marketplace 里 `zoceanfly` 的那个账号（不要误登公司账号）  
2. 右上角头像 → **Personal access tokens** → **New Token**  
   （或：https://dev.azure.com → 任意组织 → User settings → Personal access tokens）  
3. 表单按下面填：

| 项 | 值 |
| --- | --- |
| Name | 任意，如 `vsce-oceanview` |
| Organization | **All accessible organizations**（不要只选某个无关组织） |
| Expiration | 按需（如 90 天） |
| Scopes | **Custom defined** → 点 **Show all scopes** → 找到 **Marketplace** → 勾选 **Manage** |

4. **Create** 后立刻复制 token（只显示一次）

#### 登录并发布

```bash
npx vsce login zoceanfly
# 粘贴上面的 PAT；成功应提示 verification succeeded

npm run publish
# 或 npm run publish:patch / publish:minor
```

也可不 `login`，临时用环境变量（PowerShell）：

```powershell
$env:VSCE_PAT="你的PAT"
npm run publish
```

扩展页：`https://marketplace.visualstudio.com/items?itemName=zoceanfly.oceanview`

仅内部分发时，对方可用「从 VSIX 安装…」安装 `oceanview-*.vsix`。

#### 常见问题（`vsce login` / `publish`）

| 报错 / 现象 | 原因与处理 |
| --- | --- |
| `TF400813` + 用户 `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` | PAT 无效或**账号对不上**：Azure 解析不到身份。用**拥有 publisher 的同一 Microsoft 账号**按上文重建 PAT（建议无痕窗口确认账号），Organization 选 **All accessible organizations**，Scopes 勾 **Marketplace → Manage**，再 `npx vsce login zoceanfly` |
| `Access Denied` / View user permissions | `package.json` 的 `publisher` 与 Marketplace 上的 ID 不一致；本仓库必须是 `zoceanfly` |
| PAT 已过期 | 重建 PAT 并重新 `vsce login` |
| 提示输入 PAT 后仍失败 | 不要用 GitHub Token / npm Token；必须是 **Azure DevOps PAT**；勿多粘空格/换行 |
| 不想折腾 PAT | 用方式 A：`npm run package` 后在管理页上传 `.vsix` |

## 发布到 Open VSX（Cursor）

Cursor 默认走 [Open VSX](https://open-vsx.org/)，需单独发布（与 VS Code 商店无关）。

认证有两条路，可并存但 **`OVSX_PAT` 优先级更高**（存在 PAT 时不会走 OIDC）：

| 方式 | 用在哪 | 需要什么 |
| --- | --- | --- |
| Access Token（`OVSX_PAT`） | 首次发布、创建命名空间、本机手动 | `ovsxat_...` token |
| Trusted Publishing（OIDC） | 之后全部 CI 发布 | 在 open-vsx.org 注册仓库 + workflow，**无需 Secret** |

### 第一次发布（必须用 Token）

Trusted Publisher 只能注册到**已存在且至少有一个 active 版本**的扩展上，所以第一次必须手动发：

1. 登录 https://open-vsx.org → Profile **签署** Eclipse Open VSX Publisher Agreement  
2. [Access Tokens](https://open-vsx.org/user-settings/tokens) 创建 Token（**只放在环境变量里，不要写进仓库**）  
3. 本机（**Node 22+**，ovsx 1.x 要求）：

```bash
nvm use 22
export OVSX_PAT=ovsxat_你的token   # PowerShell: $env:OVSX_PAT="ovsxat_你的token"

npm ci
npm run openvsx:namespace          # 首次创建命名空间 zoceanfly（只需一次）
npm run publish:openvsx            # 打包并发布到 Open VSX
```

脚本说明见 [`scripts/openvsx-publish.js`](scripts/openvsx-publish.js)（有 `OVSX_PAT` 用 PAT，没有则尝试 OIDC）。发布后页面：  
`https://open-vsx.org/extension/zoceanfly/oceanview`

### GitHub Actions：Trusted Publishing（推荐）

工作流：[`.github/workflows/publish-openvsx.yml`](.github/workflows/publish-openvsx.yml)

**1. 在 Open VSX 注册 Trusted Publisher（一次性，需已有首个版本）**

1. 打开 https://open-vsx.org/user-settings/trusted-publishers
2. 选择命名空间 **`zoceanfly`**（必须是 owner，仅 contributor 不够）
3. Provider 选 **GitHub Actions**，填：

| 字段 | 值 |
| --- | --- |
| Organization or User name | `zhhOceanfly` |
| Repository name | `OceanView` |
| Workflow filename | `publish-openvsx.yml`（只填文件名，含 `.yml`） |
| Environment name | 留空（除非 job 里用了 GitHub environment） |

4. 确认保存。每个扩展只能有 **一个** Trusted Publisher；改仓库名 / workflow 文件名都要重新注册。

**2. 删除 `OVSX_PAT` Secret（重要）**

`--pat` / `OVSX_PAT` 的优先级**高于** OIDC。仓库里若还留着 `OVSX_PAT`，workflow 会继续按旧 token 发布而不是走 trusted publishing：  
仓库 → **Settings** → **Secrets and variables** → **Actions** → 删除 `OVSX_PAT`。

**3. 触发发布**

任选其一（发布前先把根目录 `package.json` 的 `version` 升到目标版本并推送）。  
**Tag 前缀与 npm / DBX 分开**，避免一次 push 触发多个发布：

| 渠道 | Tag 示例 | Workflow |
|------|----------|----------|
| Open VSX | `ext-v0.1.3` | `publish-openvsx.yml` |
| npm CLI | `cli-v0.1.3` | `publish-npm-cli.yml` |
| DBX | `dbx-v0.1.3` | `publish-dbx-plugin.yml` |

| 方式 | 操作 |
|------|------|
| 手动 | Actions → **Publish Open VSX** → **Run workflow** |
| Tag | `git tag ext-v0.1.3 && git push origin ext-v0.1.3` |

工作流会 `npm ci` → `npm run package` → `ovsx publish --trusted-publishing`（OIDC 换 5 分钟短期 token，只对本扩展有效）。
同一版本已存在时 Open VSX 会拒绝，需先升版本。

**限制与坑**

- 只能用 **GitHub 托管 runner**（self-hosted 不支持）
- `id-token: write` 必须开；`ovsx` 需 **≥ 1.1.0**（本仓库 devDependency 已钉 `^1.4.0`），Node **≥ 22**
- 若扩展的所有版本都被删光，注册会失效（页面仍显示，但换 token 时报 `No trusted publisher matches the presented token`）；重新发一个版本即恢复
- 私有仓库注册会拿到一个 `registrationCode`，首次发布需传 `OVSX_REGISTRATION_CODE`

Cursor 对 Open VSX 有镜像同步延迟（常见数小时）；也可在 Cursor 里用「从 VSIX 安装」。用完整 ID 搜索：`zoceanfly.oceanview`。

## 发布 npm CLI（`@zhhoceanfly/oceanview`）

供 Rider 等环境在浏览器使用 ProtoView Client，与扩展共用 Client 页面逻辑。包目录：[`packages/cli`](packages/cli)，说明见 [`packages/cli/README.md`](packages/cli/README.md)。

npm 组织：**`zhhoceanfly`**（与 VS Code Marketplace publisher `zoceanfly` 不同，勿混用）。  
包页面：https://www.npmjs.com/package/@zhhoceanfly/oceanview  

### 推荐：GitHub Actions（Trusted Publishing，无浏览器 MFA）

工作流：[`.github/workflows/publish-npm-cli.yml`](.github/workflows/publish-npm-cli.yml)  
本机 `npm publish` 会走交互式 2FA；CI 用 **OIDC Trusted Publishing** 可完全跳过浏览器二次验证，也**不必**长期存放 `NPM_TOKEN`。

**1. 在 npm 绑定 Trusted Publisher（一次性）**

> 前置：**包必须已存在于 npm 上**。`@zhhoceanfly/oceanview` 现在还没发布过（改名后是新包名），必须先在本机用 token 发一次 0.1.1，才能配置 Trusted Publisher。首次发布见下文「本机手动发布」。

1. 打开包 Settings：https://www.npmjs.com/package/@zhhoceanfly/oceanview → **Settings** → **Trusted Publisher**
2. 选 **GitHub Actions**，填写（须与仓库完全一致，区分大小写）：

| 项 | 值 |
| --- | --- |
| Organization or user | `zhhOceanfly`（你的 GitHub 用户/组织名） |
| Repository | `OceanView` |
| Workflow filename | `publish-npm-cli.yml`（只要文件名，含 `.yml`） |
| Environment name | 留空（除非 job 用了 GitHub environment） |
| Allowed actions | 至少勾 **`npm publish`** |

3. 保存后 **2 天内**必须用该 workflow **成功发布一次**，否则配置过期需重建。

也可用 CLI 配置（需账号已开 2FA、npm ≥ 11.15）：

```bash
npm trust github @zhhoceanfly/oceanview --repo zhhOceanfly/OceanView --file publish-npm-cli.yml --allow-publish
```

**2. 升版本并触发**

先改 [`packages/cli/package.json`](packages/cli/package.json) 的 `version`（与扩展版本**不必相同**；**同版本不能重复发**），提交推送后任选：

| 方式 | 操作 |
|------|------|
| 手动 | Actions → **Publish npm CLI** → **Run workflow** |
| Tag | `git tag cli-v0.1.3 && git push origin cli-v0.1.3`（tag 名仅作触发，真正版本以 `packages/cli` 的 `version` 为准，当前 **0.1.3**） |

工作流会 `npm ci` → `build:cli` → `npm publish ./packages/cli`。OIDC 由 `permissions.id-token: write` 提供，无需 Secret；不传 `NODE_AUTH_TOKEN`，npm 会自动走 OIDC 并生成 provenance。

要求：**GitHub 托管 runner**、**Node ≥ 22.14**（workflow 用 24）、**npm CLI ≥ 11.5.1**（workflow 里会 `npm i -g npm@^11.5.1`）。workflow 还会先查 `npm view`，该版本已存在则跳过发布，避免 tag 重跑报错。

**3. 备选：Granular Token（未配 Trusted Publisher 时）**

1. npm → Access Tokens → **Granular** → 对该包 Read and write，并勾选 **Bypass 2FA**  
2. 仓库 Settings → Secrets → Actions → 新建 `NPM_TOKEN`，并在 workflow 的 publish 步骤加 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`

注意：本仓库 workflow **默认不读 `NPM_TOKEN`**（纯 OIDC）。要回退到 token 发布需自行把该 env 加回去；配好 Trusted Publisher 后建议在包 Settings → **Publishing access** 选「Require 2FA and disallow tokens」，并撤销不再需要的 publish token。

### 本机手动发布（会触发浏览器 / OTP MFA）

1. 在 [npmjs.com](https://www.npmjs.com/signup) **注册官方账号**（不要用 CNPM / npmmirror 注册页）  
2. 已创建组织 [zhhoceanfly](https://www.npmjs.com/settings/zhhoceanfly/members)，且当前账号为 owner / 有 publish 权限  
3. 包为**公开**包（`publishConfig.access: public`）  
4. **登录必须指向官方 registry**（国内若默认源是 npmmirror，直接 `npm login` 会进 CNPM）

```bash
npm config get registry
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

浏览器应打开 **npmjs.org** 的登录/授权页，而不是「Sign up to CNPM」。  
`packages/cli` 已配置 `publishConfig.registry = https://registry.npmjs.org/`。

升版本并发布：

```bash
cd packages/cli
npm version patch    # 或手改 version
cd ../..
npm run publish:cli
```

等价于 `npm run build:cli` + `npm publish ./packages/cli --access public --registry https://registry.npmjs.org/`。

**注意 Node 版本**：`npm publish` 在 Node 22.10 及更旧版本上可能因依赖升级报错，建议本机 `nvm use 22` 取最新补丁版或更直接用 **node 24**。

**不要**在仓库根目录执行 `npm publish`：根包 `"private": true`。  
正确包名是 **`@zhhoceanfly/oceanview`**（两个 `h`）。

验证：

```bash
npm view @zhhoceanfly/oceanview version --registry=https://registry.npmjs.org/
npx @zhhoceanfly/oceanview@latest --help
```

构建脚本：[`scripts/build-cli.js`](scripts/build-cli.js)。打进 npm 的内容见 `packages/cli` 的 `files` 字段。

### 常见问题

| 问题 | 处理 |
| --- | --- |
| 打开「Sign up to CNPM」/ `Public registration is not allowed` | 当前默认源是 npmmirror；改用 `npm login --registry=https://registry.npmjs.org/` |
| 本机发布要浏览器 MFA / OTP | 正常；改用上面的 **Trusted Publishing** 工作流即可免交互 |
| CI `Unable to authenticate` / `ENEEDAUTH` | 检查 Trusted Publisher 的用户名/仓库/workflow 文件名是否完全一致；新建后是否已在 2 天内成功发过一次；workflow 是否含 `id-token: write` |
| CI `Cannot publish over existing version` | 先升 `packages/cli` 的 `version` 再跑 workflow |
| `You do not have permission to publish` | 账号不是组织 `zhhoceanfly` 成员；确认登录的是有权限的账号 |
| `Cannot publish over existing version` / `PUT .../oceanview`（无 scope） | 误发了根包：用 `npm run publish:cli` 或 CI workflow |
| 发布后 `npx` 仍是旧版 | 镜像延迟：指定版本或查官方 registry |

### 本地试跑（不发布）

```bash
npm run build:cli
node packages/cli/bin/oceanview.js --proto ./你的proto目录 --port 3920
```

### 开发调试（免每次 build）

```bash
npm run dev:cli
# 或带参数
npm run dev:cli -- --proto ./你的proto目录 --port 3920
```

- 改 `client/`（页面 JS/CSS）→ **浏览器刷新**即可  
- 改 `src/` 或 `packages/cli/src` → 自动 `tsc` 并重启服务  
- 开发时静态资源直连仓库 `client/`，不必再 `build:cli` 复制到 `public/`  
- **正式发布前仍须** `npm run publish:cli`（或至少 `build:cli`），确保 `public/` / `dist/` 为最新产物

### 安装运行
```
# 查看本地当前版本
npm list -g @zhhoceanfly/protoview

# 查看 npm 仓库里的最新版本
npm view @zhhoceanfly/protoview version

# 清除 npm 缓存
npm cache clean --force

# 或者直接安装指定版本（比如 0.1.6）
npm i -g @zhhoceanfly/protoview@0.1.6
```

## 图标资源

- `media/icon.png`：商店与扩展详情（≥128×128 PNG）
- `media/icon.svg`：活动栏单色图标（随主题变色）
