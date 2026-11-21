# 04: Preserve staged and unstaged changes in All

**What to build:** A reviewer choosing All sees the staged and unstaged parts of the change separately, including both sides of an edit that cancels out in the final working tree.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] A staged edit followed by an unstaged reversal appears in both sections and can be walked through.
- [x] New untracked files appear in the unstaged section.
- [x] Each stop opens the exact staged or unstaged hunk it references, including when both sections touch the same file and lines.
- [x] Server-side RPC tests exercise the reversal and untracked cases against a real Git fixture.
