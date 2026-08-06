---
name: document
description: Read, analyze, transform, edit, or generate PDF, Word, Excel, PowerPoint, CSV, Markdown, HTML, text, and image-backed office documents. Use when a user uploads a document or requests document creation, conversion, extraction, comparison, or modification.
---

# Document Processing

## Workflow

1. Identify the file type and the user's intended output before processing.
2. Use the project's standard LangChain loader for ordinary text extraction.
3. Use the structured Docling path for complex PDF or Office content containing headings, tables, images, or layout-sensitive sections.
4. Preserve source location metadata such as page, section, slide, sheet, table, and paragraph when available.
5. Retrieve only the necessary chunks for question answering; do not inject an entire large document into model context.
6. For modification, edit from the original uploaded file and produce a new downloadable version.
7. Explain unsupported model capabilities in user language without exposing implementation terms such as OCR.

## Boundaries

- Never invent content that could not be extracted from the source.
- Keep uploaded originals unchanged.
- Do not silently switch to another chat model.
- If extraction quality is insufficient, state the limitation and suggest a supported mode or clearer source.
