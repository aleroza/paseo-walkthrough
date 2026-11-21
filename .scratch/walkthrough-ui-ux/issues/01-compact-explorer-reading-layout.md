# 01: Use a compact reading layout in Explorer

**What to build:** A reviewer chooses a source in Explorer, generates a walkthrough, and reads each explanation alongside its code. The finished document fills the panel, with compact controls and a separate action to view the full diff.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] The initial view offers the source picker, the existing commit dropdown for commit scope, and Generate.
- [x] With a document open, the toolbar makes the source and generation actions accessible. Model and language are available in an options menu.
- [x] Each stop shows its explanation, observations, and anchored hunks together in reading order.
- [x] The complete source diff opens through a separate action. The Not covered section is collapsed by default and expands in place.
- [x] The layout is usable in narrow and wide Explorer panels, including keyboard navigation and the host theme.
