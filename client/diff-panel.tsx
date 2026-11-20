import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { diffRpc } from "../shared/contracts";
import type { Diff, DiffFile, Hunk } from "../shared/types";

const POLL_MS = 4_000;

type Colors = PluginTheme["colors"];

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
    const [diff, setDiff] = useState<Diff | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
      client.rpc(diffRpc, { workspaceId, scope: "all" }).then(
        (result) => {
          setDiff(result.diff);
          setError(result.error);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      );
    }, [client, workspaceId]);

    useEffect(() => {
      load();
      const timer = setInterval(load, POLL_MS);
      return () => clearInterval(timer);
    }, [load]);

    const empty = error
      ? null
      : !diff
        ? "Reading the working tree..."
        : !diff.repository
          ? "This workspace is not a git repository, so there is nothing to walk through."
          : diff.files.length === 0
            ? "No changes in the working tree."
            : null;

    return (
      <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={[styles.content, layout.compact && styles.contentCompact]}>
        {error ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{error}</Text> : null}
        {diff ? (
          <Text style={[styles.summary, { color: colors.foreground }]}>
            {`${diff.fileCount} ${diff.fileCount === 1 ? "file" : "files"}, ${diff.hunkCount} ${diff.hunkCount === 1 ? "hunk" : "hunks"}`}
          </Text>
        ) : null}
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
  summary: { fontSize: 13, fontWeight: "600" },
  file: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  fileHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  path: { fontSize: 13, fontWeight: "600", flex: 1, minWidth: 0 },
  meta: { fontSize: 12 },
  hunk: { gap: 2 },
  hunkHeader: { fontSize: 11, fontFamily: "monospace" },
  code: { fontSize: 12, fontFamily: "monospace" },
});
