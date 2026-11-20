import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { diffSchema, documentSchema, walkthroughSourceSchema } from "../shared/types";
import type { Diff, WalkthroughSource } from "../shared/types";

const entrySchema = z.object({
  key: z.string(),
  source: walkthroughSourceSchema,
  diff: diffSchema,
  document: documentSchema,
});
export type CacheEntry = z.infer<typeof entrySchema>;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function identifyChange(
  root: string,
  relativeDirectory: string,
  source: WalkthroughSource,
  base: string | null,
  model: string,
  language: string,
  diff: Diff,
) {
  const files = diff.files.map((file) =>
    hash([file.path, file.oldPath, file.status, file.binary, file.hunks.map((hunk) => hash([hunk.id, hunk.patch])).sort()]),
  );
  return {
    bucket: hash([root, source.scope]),
    key: hash([root, relativeDirectory, source.scope, source.commit ?? null, base, model, language, files.sort()]),
  };
}

async function readEntry(path: string): Promise<CacheEntry | null> {
  try {
    const parsed = entrySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeEntry(path: string, entry: CacheEntry, canWrite: () => boolean) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
    if (canWrite()) await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createWalkthroughCache(dataDirectory: string) {
  const directory = join(dataDirectory, "cache");
  const bucketPath = (bucket: string) => join(directory, "sources", `${bucket}.json`);
  const workspacePath = (workspaceId: string) => join(directory, "workspaces", `${hash(workspaceId)}.json`);

  return {
    async find(bucket: string, key: string) {
      const saved = await readEntry(bucketPath(bucket));
      return saved?.key === key ? saved : null;
    },
    last(workspaceId: string) {
      return readEntry(workspacePath(workspaceId));
    },
    async save(bucket: string, workspaceId: string, entry: CacheEntry, canWrite: () => boolean, cacheHit: boolean) {
      const writes = [writeEntry(workspacePath(workspaceId), entry, canWrite)];
      // The workspace's snapshot survives replacement of a shared source by another workspace.
      if (!cacheHit) writes.push(writeEntry(bucketPath(bucket), entry, canWrite));
      await Promise.allSettled(writes);
    },
  };
}
