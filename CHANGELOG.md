# 更改日志

本文件记录 OceanView 的版本变更。扩展详情页的「更改日志」标签会读取它。

## [0.1.3] — 2026-11-11

### 修复

- **ExcelView Client 查找定位滚动无效**：`applyExcelPage` 调用了定义在 `bind()` 内的 `applyExcelEditability`，渲染表格后抛 `ReferenceError`，导致表格出来但滚动条从不动。已把该函数提到模块作用域，恢复定位滚动。
- **定位兜底**：按 `data-row`/`data-col` 直接找目标格，累加行列尺寸后校正所有可滚动祖先，仍不可见时回退 `scrollIntoView`；同页命中不再重复请求 `excelPage`，避免竞态丢 `focus`。

### 功能

- **ExcelView 横向滚动**：按住鼠标右键 + 滚轮横向滚动，单独滚轮保持纵向（Client 与直接打开的 Excel 编辑器一致）。
- **DocsView Client 查找栏**：顶部补上查找框、清空、上下箭头与 `当前/总数`（此前只加在 `index.html`，扩展面板未生效）。

## [0.1.2] — 2026-11-11

### 修复

- **ExcelView 搜索定位**：Tab / 首页搜索命中后打开表时，不再裁切顶部 `##type` / `##group` 等配置行；命中单元格滚入表格可视区并高亮。
- **首次搜索 Excel 为空**：打开全局搜索时预热索引；搜索请求带 `requestId`，避免建索引期间旧回包冲掉新查询；搜索中显示「正在索引 / 搜索 Excel…」。
- **目录刷新冲掉定位**：仅手动刷新索引时重载当前打开的表，搜索跳转不会被无 focus 的 page 回包覆盖。

### 功能

- **Excel / Docs 表内查找**：ExcelView Client、直接打开的 Excel 自定义编辑器、DocsView Client / Docs 自定义编辑器均提供查找框 + `当前/总数` + 上下箭头；`Enter` 等同下一处，`Ctrl+F` 聚焦查找框；Excel 可跨 Sheet，标签显示匹配数。
- **查找定位滚动**：命中单元格按行高/列宽累加滚入真正的滚动容器，避免“已定位但看不见”。

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
