import { appConfig } from "../config";
import { chromaVectorStore } from "./chromaVectorStore";
import { sqliteVectorStore } from "./sqliteVectorStore";

// 学习点：这里是向量库的“总开关”。
// 如果 .env 配置为 chroma，就用 Chroma 做向量检索；
// 否则用 SQLite fallback，让项目不用额外服务也能跑通学习流程。
export const vectorStore =
  appConfig.vectorStoreProvider === "chroma" ? chromaVectorStore : sqliteVectorStore;
