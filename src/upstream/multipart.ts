/**
 * 极简 multipart/form-data 构造器。
 *
 * 为什么不用 `FormData`：主进程代理通过 JSON IPC 传输，无法直接传 FormData；
 * 而自建 multipart 字节流在「直连」与「代理」两条路径上语义完全一致，
 * 也让单元测试可以断言真实的上传报文结构。
 */

export interface MultipartFile {
  /** 表单字段名，输入层固定为 `file` */
  field: string;
  /** 上传文件名，输入层按扩展名/魔数识别格式 */
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export interface MultipartBody {
  bytes: Uint8Array;
  contentType: string;
}

const CRLF = "\r\n";

/** 依据浏览器/Node 环境选择随机 boundary 来源。 */
function makeBoundary(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw =
    cryptoApi?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `----dounai${raw.replace(/-/g, "")}`;
}

export function buildMultipart(
  file: MultipartFile,
  fields: Record<string, string | undefined> = {},
): MultipartBody {
  const boundary = makeBoundary();
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  // 普通字段
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(
      encoder.encode(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
          `${value}${CRLF}`,
      ),
    );
  }

  // 文件字段
  parts.push(
    encoder.encode(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"${CRLF}` +
        `Content-Type: ${file.mime}${CRLF}${CRLF}`,
    ),
  );
  parts.push(file.bytes);
  parts.push(encoder.encode(`${CRLF}--${boundary}--${CRLF}`));

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return {
    bytes,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** 从文件名或 MIME 推断输入层接受的扩展名（输入层按扩展名 + 魔数校验）。 */
export function guessExtension(filename: string, mime: string): string {
  const fromName = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (fromName) return fromName;

  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
  };
  return map[mime.toLowerCase()] ?? "bin";
}
