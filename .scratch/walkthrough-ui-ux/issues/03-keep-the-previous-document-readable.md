# 03: Keep the previous document readable

**What to build:** A reviewer can change the walkthrough request or start another generation while continuing to read the displayed document.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] The displayed document identifies its actual source, commit when applicable, model, and language when any of them differ from the current request.
- [x] Starting another generation keeps the document and reading position in place while the panel shows progress.
- [x] Cancellation and failure leave the document and reading position in place. The panel shows the outcome and allows another attempt.
- [x] A successful generation replaces the displayed document. Late responses from older requests cannot replace it.
- [x] Previously saved documents still open. Missing metadata is treated as unknown.
- [x] Server-side RPC tests cover request identity and the result available after a failed or cancelled replacement.
