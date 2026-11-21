# 07: Find text across the walkthrough and diff

**What to build:** A reviewer can search once across the explanation and the diff, then go directly to each match in reading order.

**Blocked by:** 02 (Navigate the walkthrough by stop), 05 (Mark outdated stops and show uncovered hunks).

**Status:** resolved

- [x] Search finds text in walkthrough explanations and displayed diff lines.
- [x] Next and Previous move through matches in reading order and identify the current match.
- [x] A match in Not covered opens that section and scrolls to the matching text.
- [x] Matches remain distinct when the same file appears in multiple stops. Replacing the document refreshes the results.
- [x] Search and match navigation are verified in a live Explorer panel.
