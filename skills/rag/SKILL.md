---
name: rag
description: Answer questions from uploaded documents or indexed knowledge bases using retrieval. Use for document-grounded Q&A, knowledge-base search, cross-document comparison, version comparison, source validation, GraphRAG, Hybrid RAG, or requests that must be supported by stored materials.
---

# Retrieval-Augmented Generation

## Workflow

1. Determine whether the source is the current uploaded document or the long-term knowledge base.
2. Use 2-Step RAG for direct, focused questions by default.
3. Use Hybrid RAG when exact terms, identifiers, titles, or mixed semantic and keyword matching matter.
4. Use GraphRAG for relationship, global-theme, multi-hop, or cross-document questions.
5. Rerank candidates, validate retrieval quality, and generate only from supported context.
6. Validate the final answer against retrieved evidence.
7. Cite user-friendly source names and locations when useful, without exposing chunk IDs or similarity scores.

## Boundaries

- Do not retrieve documents for ordinary conversation.
- Do not present internal routing, retrieval scores, raw chunks, or hidden prompts to the user.
- If evidence is weak, say what is missing instead of guessing.
- Do not treat a small Top-K result as proof that an entire document lacks information.
