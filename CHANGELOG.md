# 更改日志

本文件记录 OceanView 的版本变更。扩展详情页的「更改日志」标签会读取它。

## [0.1.1] — 2026-11-10

首个 OceanView 版本：由 ProtoView 更名而来，版本号重置为 **0.1.1**。

### 调整

- 插件名、命令前缀、配置项、扩展 ID 与 DBX 插件 ID 统一为 `oceanview`，DBX 展示名由 ApiMan 改为 OceanView。
- 工作区配置目录改为 `.oceanview/`，CLI 包名改为 `@zhhoceanfly/oceanview`（命令 `oceanview`）。
- 子视图命名保持不变：ProtoView Client、ExcelView、DocsView、DbView。

### 功能

- Proto 浏览：按 `package → service → 接口` 组织侧边栏，类型互跳、源码定位、格式化与补全。
- Proto 来源：工作区自动识别，或 Git 地址 / 分支拉取到临时目录。
- ProtoView Client：gRPC / HTTP / SSE / WebSocket 调用，多环境、Auth、grpcurl 生成、压测、链路调试。
- ExcelView / DocsView / DbView：Excel、Markdown、SQL 的浏览、搜索与差异对比。

## 历史（ProtoView 时期）

更名前以 **ProtoView** 名称发布过 0.1.0 ～ 0.1.6，逐版明细见 Git 历史；要点：

- 0.1.0：首个 Marketplace 版本，Proto 浏览 + Client + 链路调试
- 0.1.1 ～ 0.1.2：接口级 gRPC / HTTP 切换、图标调整
- 0.1.3：SSE / WebSocket、npm CLI `@zhhoceanfly/protoview`、链路导入导出
- 0.1.5 ～ 0.1.6：源码打开方式、链路变量节点与枚举名显示、DBX 插件（ApiMan）
