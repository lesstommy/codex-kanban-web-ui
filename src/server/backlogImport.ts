import {
  BULK_IMPORT_MAX_ROWS,
  DEFAULT_TASK_ROLE,
  TASK_ROLE_VALUES,
  THREAD_NAME_LIMIT,
  type TaskRole,
  USER_POST_LIMIT
} from "../shared/schemas";
import type { BulkImportBacklogPreviewDto, BulkImportBacklogRowDto, BulkImportBacklogRowErrorDto } from "../shared/types";

const expectedHeaders = ["client_key", "name", "role", "body"];
const roleAliases: Record<string, TaskRole> = {
  se: "se",
  "程序": "se",
  art: "art",
  "美术": "art",
  design: "design",
  "策划": "design",
  music: "music",
  "音乐": "music",
  general: "general",
  "综合": "general"
};
const roleHelp = "role 必须是 se/程序、art/美术、design/策划、music/音乐、general/综合。";

interface CsvRecord {
  rowNumber: number;
  fields: string[];
}

export function parseBacklogImportCsv(csv: string): BulkImportBacklogPreviewDto {
  const parsed = parseCsv(csv.replace(/^\uFEFF/, ""));
  const errors: BulkImportBacklogRowErrorDto[] = [...parsed.errors];
  const records = parsed.records.filter((record) => record.fields.some((field) => field.trim()));
  if (records.length === 0) {
    return { totalRows: 0, validRows: 0, rows: [], errors: [{ rowNumber: 1, message: "CSV 不能为空。" }] };
  }

  const header = records[0].fields.map((field) => field.trim());
  if (!hasExpectedHeader(header)) {
    return {
      totalRows: Math.max(0, records.length - 1),
      validRows: 0,
      rows: [],
      errors: [
        ...errors,
        {
          rowNumber: records[0].rowNumber,
          message: "CSV 表头必须是 client_key,name,role,body。"
        }
      ]
    };
  }

  const rows: BulkImportBacklogRowDto[] = [];
  const dataRecords = records.slice(1);
  if (dataRecords.length > BULK_IMPORT_MAX_ROWS) {
    errors.push({
      rowNumber: dataRecords[BULK_IMPORT_MAX_ROWS]?.rowNumber ?? records[records.length - 1].rowNumber,
      message: `一次最多导入 ${BULK_IMPORT_MAX_ROWS} 条任务。`
    });
  }

  for (const record of dataRecords.slice(0, BULK_IMPORT_MAX_ROWS)) {
    const [clientKeyRaw = "", nameRaw = "", roleRaw = "", bodyRaw = ""] = record.fields;
    const clientKey = clientKeyRaw.trim();
    const name = nameRaw.trim();
    const roleValue = roleRaw.trim();
    const body = bodyRaw.trim();
    if (record.fields.length !== expectedHeaders.length) {
      errors.push({
        rowNumber: record.rowNumber,
        clientKey: clientKey || undefined,
        name: name || undefined,
        message: "每行必须包含 4 列：client_key,name,role,body。"
      });
      continue;
    }
    const role = normalizeImportRole(roleValue);
    if (!role) {
      errors.push({
        rowNumber: record.rowNumber,
        clientKey: clientKey || undefined,
        name: name || undefined,
        message: roleHelp
      });
      continue;
    }
    if (!name) {
      errors.push({ rowNumber: record.rowNumber, clientKey: clientKey || undefined, message: "name 不能为空。" });
      continue;
    }
    if (name.length > THREAD_NAME_LIMIT) {
      errors.push({
        rowNumber: record.rowNumber,
        clientKey: clientKey || undefined,
        name,
        message: `name 不能超过 ${THREAD_NAME_LIMIT} 字。`
      });
      continue;
    }
    if (!body) {
      errors.push({ rowNumber: record.rowNumber, clientKey: clientKey || undefined, name, message: "body 不能为空。" });
      continue;
    }
    if (body.length > USER_POST_LIMIT) {
      errors.push({
        rowNumber: record.rowNumber,
        clientKey: clientKey || undefined,
        name,
        message: `body 不能超过 ${USER_POST_LIMIT} 字。`
      });
      continue;
    }
    rows.push({
      rowNumber: record.rowNumber,
      clientKey: clientKey || undefined,
      name,
      role,
      body
    });
  }

  return {
    totalRows: dataRecords.length,
    validRows: rows.length,
    rows,
    errors
  };
}

function hasExpectedHeader(header: string[]): boolean {
  return header.length === expectedHeaders.length && expectedHeaders.every((expected, index) => header[index] === expected);
}

function normalizeImportRole(value: string): TaskRole | undefined {
  if (!value) {
    return DEFAULT_TASK_ROLE;
  }
  const normalized = value.trim().toLowerCase();
  if (TASK_ROLE_VALUES.includes(normalized as TaskRole)) {
    return normalized as TaskRole;
  }
  return roleAliases[normalized];
}

function parseCsv(input: string): { records: CsvRecord[]; errors: BulkImportBacklogRowErrorDto[] } {
  const records: CsvRecord[] = [];
  const errors: BulkImportBacklogRowErrorDto[] = [];
  let field = "";
  let row: string[] = [];
  let rowNumber = 1;
  let recordStartRow = 1;
  let inQuotes = false;
  let quoteClosed = false;

  const pushField = () => {
    row.push(field);
    field = "";
    quoteClosed = false;
  };

  const pushRecord = () => {
    pushField();
    records.push({ rowNumber: recordStartRow, fields: row });
    row = [];
    recordStartRow = rowNumber + 1;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inQuotes) {
      if (char === "\"") {
        if (next === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        if (char === "\n") {
          rowNumber += 1;
        }
        field += char;
      }
      continue;
    }

    if (quoteClosed && char !== "," && char !== "\n" && char !== "\r" && char.trim()) {
      errors.push({
        rowNumber,
        message: "引号闭合后只能跟逗号或换行。"
      });
    }

    if (char === "\"") {
      if (field.trim().length > 0) {
        errors.push({
          rowNumber,
          message: "字段中间不能直接出现双引号，请使用两个双引号转义。"
        });
      }
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      pushField();
      continue;
    }

    if (char === "\n") {
      pushRecord();
      rowNumber += 1;
      recordStartRow = rowNumber;
      continue;
    }

    if (char === "\r") {
      if (next === "\n") {
        continue;
      }
      pushRecord();
      rowNumber += 1;
      recordStartRow = rowNumber;
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    errors.push({
      rowNumber: recordStartRow,
      message: "存在未闭合的双引号。"
    });
  }

  if (field.length > 0 || row.length > 0 || input.endsWith(",")) {
    pushRecord();
  }

  return { records, errors };
}
