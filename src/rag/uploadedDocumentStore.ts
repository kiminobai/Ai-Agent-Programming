/**
 * 当前项目的上传文档临时仓库。
 *
 * 设计目标：
 * 1. 文件由用户在聊天输入区上传，并跟随一条消息进入线程。
 * 2. 服务端先把解析后的文档内容挂到当前 thread_id 上。
 * 3. Agent 是否读取、切分、总结这份文档，交给模型按用户意图决定。
 *
 * 这里先使用内存存储，便于完成本阶段的 Agent 行为验证。
 */
export interface UploadedDocumentRecord {
  threadId: string;
  userId: string;
  fileName: string;
  fileType: "markdown" | "pdf" | "text";
  text: string;
  uploadedAt: string;
}

const uploadedDocumentByThread = new Map<string, UploadedDocumentRecord>();

export function saveUploadedDocument(record: UploadedDocumentRecord): void {
  uploadedDocumentByThread.set(record.threadId, record);
}

export function getUploadedDocument(
  threadId: string
): UploadedDocumentRecord | undefined {
  return uploadedDocumentByThread.get(threadId);
}
