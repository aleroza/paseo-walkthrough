import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { diffRpc } from "../shared/contracts";
import type { WalkthroughScope } from "../shared/constants";
import type { Diff, DiffFile, Hunk } from "../shared/types";

const POLL_MS = 4_000;

type Colors = PluginTheme["colors"];

const SOURCES: { scope: WalkthroughScope; label: string }[] = [
  { scope: "all", label: "All" },
  { scope: "staged", label: "Staged" },
  { scope: "unstaged", label: "Unstaged" },
  { scope: "branch", label: "Branch" },
  { scope: "commit", label: "Commit" },
];

const EMPTY: Record<WalkthroughScope, string> = {
  all: "No changes in the working tree.",
  staged: "Nothing is staged.",
  unstaged: "No unstaged changes.",
  branch: "This branch has no changes against its base.",
  commit: "That commit changed no files.",
};

const NO_BASE = "This branch has no base branch to compare against.";

const PENDING: Record<WalkthroughScope, string> = {
  all: "Reading the working tree...",
  staged: "Reading the staged changes...",
  unstaged: "Reading the unstaged changes...",
  branch: "Reading the branch...",
  commit: "Enter the hash of the commit to walk through.",
};

const statusColor = (colors: Colors, status: DiffFile["status"]) => {
  if (status === "added") return colors.statusSuccess;
  if (status === "deleted") return colors.statusDanger;
  if (status === "renamed") return colors.statusWarning;
  return colors.foregroundMuted;
};

const lineColor = (colors: Colors, line: string) => {
  if (line.startsWith("+")) return colors.statusSuccess;
  if (line.startsWith("-")) return colors.statusDanger;
  return colors.foregroundMuted;
};

function HunkView({ hunk, colors }: { hunk: Hunk; colors: Colors }) {
  const body = hunk.patch.split("\n").slice(1);
  if (body.length > 0 && body[body.length - 1] === "") body.pop();
  return (
    <View style={styles.hunk}>
      <Text style={[styles.hunkHeader, { color: colors.foregroundMuted }]}>{hunk.header}</Text>
      {body.map((line, index) => (
        <Text key={index} style={[styles.code, { color: lineColor(colors, line) }]}>
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </View>
  );
}

function FileView({ file, generated, colors }: { file: DiffFile; generated: boolean; colors: Colors }) {
  const added = file.hunks.reduce((sum, hunk) => sum + hunk.added, 0);
  const deleted = file.hunks.reduce((sum, hunk) => sum + hunk.deleted, 0);
  return (
    <View style={[styles.file, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
      <View style={styles.fileHeader}>
        <Text style={[styles.path, { color: colors.foreground }]} numberOfLines={1}>
          {file.path}
        </Text>
        <Text style={[styles.meta, { color: statusColor(colors, file.status) }]}>{file.status}</Text>
        {generated ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>generated</Text> : null}
        <Text style={[styles.meta, { color: colors.foregroundMuted }]}>
          {`+${added} -${deleted}`}
        </Text>
      </View>
      {file.oldPath ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{`was ${file.oldPath}`}</Text> : null}
      {file.binary ? (
        <Text style={[styles.meta, { color: colors.foregroundMuted }]}>Binary file, no hunks to read.</Text>
      ) : (
        file.hunks.map((hunk) => <HunkView key={hunk.id} hunk={hunk} colors={colors} />)
      )}
    </View>
  );
}

export function createDiffPanel(client: PluginClientContext) {
  return function WalkthroughPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
    const colors = theme.colors;
    const [scope, setScope] = useState<WalkthroughScope>("all");
    const [commit, setCommit] = useState("");
    const [draft, setDraft] = useState("");
    const [diff, setDiff] = useState<Diff | null>(null);
    const [base, setBase] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
      if (scope === "commit" && !commit) {
        setDiff(null);
        setBase(null);
        setError(null);
        return;
      }
      client.rpc(diffRpc, { workspaceId, scope, ...(scope === "commit" ? { commit } : {}) }).then(
        (result) => {
          setDiff(result.diff);
          setBase(result.base ?? null);
          setError(result.error);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      );
    }, [client, workspaceId, scope, commit]);

    useEffect(() => {
      load();
      const timer = setInterval(load, POLL_MS);
      return () => clearInterval(timer);
    }, [load]);

    const applyCommit = useCallback(() => setCommit(draft.trim()), [draft]);

    const empty = error
      ? null
      : !diff
        ? PENDING[scope]
        : !diff.repository
          ? "This workspace is not a git repository, so there is nothing to walk through."
          : diff.files.length === 0
            ? scope === "branch" && !base
              ? NO_BASE
              : EMPTY[scope]
            : null;

    return (
      <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={[styles.content, layout.compact && styles.contentCompact]}>
        <View style={styles.sources}>
          {SOURCES.map((source) => {
            const active = source.scope === scope;
            return (
              <Pressable
                key={source.scope}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show the ${source.label} changes`}
                onPress={() => setScope(source.scope)}
                style={[styles.source, { borderColor: colors.border, backgroundColor: active ? colors.accent : colors.surface1 }]}
              >
                <Text style={[styles.sourceText, { color: active ? colors.accentForeground : colors.foreground }]}>{source.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {scope === "commit" ? (
          <View style={styles.commit}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={applyCommit}
              placeholder="Commit hash"
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.commitInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show the commit"
              onPress={applyCommit}
              style={[styles.source, { borderColor: colors.border, backgroundColor: colors.accent }]}
            >
              <Text style={[styles.sourceText, { color: colors.accentForeground }]}>Show</Text>
            </Pressable>
          </View>
        ) : null}
        {error ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{error}</Text> : null}
        {diff ? (
          <Text style={[styles.summary, { color: colors.foreground }]}>
            {`${diff.fileCount} ${diff.fileCount === 1 ? "file" : "files"}, ${diff.hunkCount} ${diff.hunkCount === 1 ? "hunk" : "hunks"}`}
          </Text>
        ) : null}
        {base ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{`compared against ${base}`}</Text> : null}
        {empty ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{empty}</Text> : null}
        {diff?.files.map((file) => (
          <FileView key={file.path} file={file} generated={diff.generatedPaths.includes(file.path)} colors={colors} />
        ))}
      </ScrollView>
    );
  };
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 10 },
  contentCompact: { padding: 12 },
  sources: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  source: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  sourceText: { fontSize: 12, fontWeight: "600" },
  commit: { flexDirection: "row", alignItems: "center", gap: 8 },
  commitInput: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12 },
  summary: { fontSize: 13, fontWeight: "600" },
  file: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  fileHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  path: { fontSize: 13, fontWeight: "600", flex: 1, minWidth: 0 },
  meta: { fontSize: 12 },
  hunk: { gap: 2 },
  hunkHeader: { fontSize: 11, fontFamily: "monospace" },
  code: { fontSize: 12, fontFamily: "monospace" },
});
