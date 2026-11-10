import * as path from "path";
import { docCatalog, docPage, docSave, docSearch } from "./docIndex";
import { excelCatalogMerged } from "./excelIndex";
import { collectCodeSymbols } from "./codeSymbols";
import {
  dbDatabases,
  dbDiffSchemas,
  dbInitDatabases,
  dbMutate,
  dbPlanSchema,
  dbQuery,
  dbTableDefinition,
  dbTablePage,
  dbTestConnection,
  loadDbEnvs,
  saveDbEnvs,
  DbEnvFile,
} from "./dbSession";
import { sqlCatalogMerged, sqlSearchMerged } from "./sqlIndex";

/**
 * db 系列的多根目录：**工作区在前**（环境文件落在这里），两个根都参与 SQL 扫描。
 * 上传 proto 到临时目录后，SQL 仍在原工作区。
 */
function dbRoots(root: string, extra: string): string[] {
  const roots = rootsOf(root, extra);
  const extraText = String(extra || "").trim();
  if (!extraText) return roots;
  const extraAbs = path.resolve(extraText);
  return [extraAbs, ...roots.filter((item) => item !== extraAbs)];
}

/** 索引扫描根：Proto 目录 + 原工作区（上传/自定义目录时两者不同） */
function rootsOf(root: string, extra: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [root, extra]) {
    const text = String(item || "").trim();
    if (!text) continue;
    const abs = path.resolve(text);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** 面板打开后在后台建索引。之后搜索直接走内存。 */
export function warmSearchIndexes(root: string, extraRoot = ""): void {
  void excelCatalogMerged([root, extraRoot], false);
  void docCatalog(root, false, extraRoot);
  void sqlCatalogMerged(rootsOf(root, extraRoot), false);
  if (String(root || "").trim()) void collectCodeSymbols(root, false);
}

/** Docs / SQL / 数据库消息。不认识的类型返回 null，交给原来的处理。 */
export async function handleOceanMessage(
  type: string | undefined,
  payload: unknown,
  root: string,
  extraRoot = "",
): Promise<Record<string, unknown> | null> {
  const body = (payload || {}) as Record<string, unknown>;
  if (type === "docCatalog") {
    return { type: "docCatalog", payload: await docCatalog(root, Boolean(body.force), extraRoot) };
  }
  if (type === "docPage") {
    return { type: "docPage", payload: await docPage(root, String(body.id || ""), extraRoot) };
  }
  if (type === "docSearch") {
    return { type: "docSearch", payload: await docSearch(root, String(body.query || ""), 40, extraRoot) };
  }
  if (type === "docSave") {
    return {
      type: "docSaved",
      payload: { id: String(body.id || ""), ...(await docSave(root, String(body.id || ""), String(body.text ?? ""), extraRoot)) },
    };
  }
  if (type === "sqlCatalog") {
    return { type: "sqlCatalog", payload: await sqlCatalogMerged(rootsOf(root, extraRoot), Boolean(body.force)) };
  }
  if (type === "sqlSearch") {
    return { type: "sqlSearch", payload: await sqlSearchMerged(rootsOf(root, extraRoot), String(body.query || "")) };
  }
  if (type === "dbEnvLoad") {
    // 环境文件属于工作区，不能存到 Proto 上传目录里（那是临时目录，重启就没了）
    return { type: "dbEnvs", payload: await loadDbEnvs(dbRoots(root, extraRoot)) };
  }
  if (type === "dbEnvSave") {
    return {
      type: "dbEnvs",
      payload: await saveDbEnvs(dbRoots(root, extraRoot), body as unknown as DbEnvFile),
    };
  }
  if (type === "dbTest") {
    return {
      type: "dbTest",
      payload: await dbTestConnection(dbRoots(root, extraRoot), {
        envId: String(body.envId || ""),
        env: (body.env || undefined) as Record<string, unknown> | undefined,
      }),
    };
  }
  if (type === "dbDatabases") {
    return {
      type: "dbDatabases",
      payload: await dbDatabases(dbRoots(root, extraRoot), { envId: String(body.envId || "") }),
    };
  }
  if (type === "dbTable") {
    return {
      type: "dbTable",
      payload: await dbTablePage(dbRoots(root, extraRoot), {
        envId: String(body.envId || ""),
        tableId: String(body.tableId || ""),
        limit: Number(body.limit || 50),
        offset: Number(body.offset || 0),
        database: String(body.database || ""),
        hostOverride: (body.hostOverride || null) as { host?: string; port?: number } | null,
      }),
    };
  }
  if (type === "dbDefinition") {
    return {
      type: "dbDefinition",
      payload: await dbTableDefinition(dbRoots(root, extraRoot), {
        envId: String(body.envId || ""),
        tableId: String(body.tableId || ""),
        database: String(body.database || ""),
        hostOverride: (body.hostOverride || null) as { host?: string; port?: number } | null,
      }),
    };
  }
  if (type === "dbUpdate" || type === "dbInsert" || type === "dbDelete") {
    const op = type === "dbUpdate" ? "update" : type === "dbInsert" ? "insert" : "delete";
    const result = await dbMutate(dbRoots(root, extraRoot), {
      op,
      envId: String(body.envId || ""),
      tableId: String(body.tableId || ""),
      pk: (body.pk || {}) as Record<string, unknown>,
      column: String(body.column || ""),
      value: body.value,
      values: (body.values || {}) as Record<string, unknown>,
      database: String(body.database || ""),
      hostOverride: (body.hostOverride || null) as { host?: string; port?: number } | null,
    });
    return { type: "dbMutate", payload: result };
  }
  if (type === "dbQuery") {
    return {
      type: "dbQuery",
      payload: await dbQuery(dbRoots(root, extraRoot), {
        envId: String(body.envId || ""),
        sql: String(body.sql || ""),
        database: String(body.database || ""),
        hostOverride: (body.hostOverride || null) as { host?: string; port?: number } | null,
      }),
    };
  }
  if (type === "dbPlan") {
    return {
      type: "dbPlan",
      payload: await dbPlanSchema(dbRoots(root, extraRoot), {
        template: String(body.template || ""),
        tables: (body.tables as { fileName: string; relative: string; table?: string }[]) || undefined,
      }),
    };
  }
  if (type === "dbInit") {
    return {
      type: "dbInit",
      payload: await dbInitDatabases(dbRoots(root, extraRoot), {
        envId: String(body.envId || ""),
        template: String(body.template || ""),
        tables: (body.tables as { fileName: string; relative: string }[]) || undefined,
        createTables: body.createTables !== false,
      }),
    };
  }
  if (type === "dbDiff") {
    return {
      type: "dbDiff",
      payload: await dbDiffSchemas(dbRoots(root, extraRoot), {
        envId: String(body.envId || ""),
        template: String(body.template || ""),
        databases: Array.isArray(body.databases) ? (body.databases as string[]) : undefined,
        tables: (body.tables as { fileName: string; relative: string }[]) || undefined,
      }),
    };
  }
  return null;
}
