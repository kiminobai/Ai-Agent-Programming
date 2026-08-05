import { appConfig } from "../config";
import { chromaVectorStore } from "./chromaVectorStore";
import { sqliteVectorStore } from "./sqliteVectorStore";
import { getDatabaseForThread, sqliteDb } from "../db/sqlite";

// 学习点：这里是向量库的“总开关”。
// 如果 .env 配置为 chroma，就用 Chroma 做向量检索；
// 否则用 SQLite fallback，让项目不用额外服务也能跑通学习流程。
export const vectorStore =
  appConfig.vectorStoreProvider === "chroma" ? chromaVectorStore : sqliteVectorStore;

// Work 模式必须完全落在当前电脑，因此不把它的向量发送到独立 Chroma 服务。
// Chat 模式仍遵循 .env 中的向量库配置。
export function getVectorStoreForThread(threadId: string) {
  return getDatabaseForThread(threadId) === sqliteDb
    ? vectorStore
    : sqliteVectorStore;
}
