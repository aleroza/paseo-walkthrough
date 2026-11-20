# Third-party notices

## OpenChamber

Parts of this plugin are ported from [OpenChamber](https://github.com/openchamber/openchamber),
in particular the walkthrough prompt, the digest, the hunk identity and the document normalizer.

Ported files:

- `server/branch.ts` — `packages/web/server/lib/git/service.ts`
- `server/digest.ts` — `packages/web/server/lib/walkthrough/digest.ts`
- `server/document.ts` — `packages/web/server/lib/walkthrough/schema.ts`
- `server/generated.ts` — `packages/web/server/lib/walkthrough/generated.ts`
- `server/patch.ts` — `packages/web/server/lib/walkthrough/hunks.ts`
- `server/prompt.ts` — `packages/web/server/lib/walkthrough/prompt.ts`

OpenChamber is distributed under the MIT License:

MIT License

Copyright (c) 2025 Bohdan Triapitsyn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
