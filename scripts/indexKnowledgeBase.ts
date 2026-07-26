import { indexKnowledgeBase } from "../src/rag/knowledgeBaseIndexer";

const knowledgeBaseId = process.argv[2] || "ai-agent-learning-manual";

indexKnowledgeBase(knowledgeBaseId)
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
