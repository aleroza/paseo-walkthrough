import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { diffRpc, generateRpc, statusRpc } from "../shared/contracts";
import type { ChapterIcon, StopImportance, WalkthroughJobState, WalkthroughScope } from "../shared/constants";
import type { Chapter, Diff, DiffFile, Hunk, Stop, WalkthroughDocument } from "../shared/types";

const POLL_MS = 4_000;
const STATUS_POLL_MS = 1_500;

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

const STAGE_LABELS: Record<WalkthroughJobState, string> = {
  collecting: "Collecting the change",
  asking: "Asking the model",
  retrying: "Retrying",
  assembling: "Assembling the document",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUNNING_STAGES: WalkthroughJobState[] = ["collecting", "asking", "retrying", "assembling"];

/**
 * The Lucide icon each icon of the document is drawn with. The names are the export names of
 * `lucide-react-native`, the set the host resolves them against: an unknown name renders nothing.
 */
const ICON_NAMES: Record<ChapterIcon, string> = {
  bug: "Bug",
  wrench: "Wrench",
  path: "Route",
  flask: "FlaskConical",
  doc: "FileText",
  gear: "Settings",
};

const statusColor = (colors: Colors, status: DiffFile["status"]) => {
  if (status === "added") return colors.statusSuccess;
  if (status === "deleted") return colors.statusDanger;
  if (status === "renamed") return colors.statusWarning;
  return colors.foregroundMuted;
};

const importanceColor = (colors: Colors, importance: StopImportance) =>
  importance === "critical" ? colors.statusWarning : colors.foregroundMuted;

const lineColor = (colors: Colors, line: string) => {
  if (line.startsWith("+")) return colors.statusSuccess;
  if (line.startsWith("-")) return colors.statusDanger;
  return colors.foregroundMuted;
};

/** The path of the hunk an id names: the id is scope, path and the hash of the hunk. */
const hunkPath = (id: string) => {
  const first = id.indexOf(":");
  const last = id.lastIndexOf(":");
  return first > 0 && last > first ? id.slice(first + 1, last) : id;
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

function StopView({ stop, colors }: { stop: Stop; colors: Colors }) {
  return (
    <View style={[styles.stop, { borderColor: colors.border }]}>
      <View style={styles.stopHeader}>
        <Text style={[styles.stopTitle, { color: colors.foreground }]}>{stop.title}</Text>
        <Text style={[styles.meta, { color: importanceColor(colors, stop.importance) }]}>{stop.importance}</Text>
      </View>
      <Text style={[styles.prose, { color: colors.foreground }]}>{stop.prose}</Text>
      <Text style={[styles.meta, { color: colors.foregroundMuted }]}>
        {stop.hunkIds.map((id) => hunkPath(id)).join(", ")}
      </Text>
      {stop.observations.map((observation, index) => (
        <View key={index} style={[styles.observation, { backgroundColor: colors.surface2 }]}>
          <View style={styles.observationHeader}>
            <Icon name={ICON_NAMES[observation.icon]} size={12} color={colors.accent} />
            <Text style={[styles.observationKind, { color: colors.accent }]}>{observation.kind}</Text>
            {observation.importance === "normal" ? null : (
              <Text style={[styles.meta, { color: importanceColor(colors, observation.importance) }]}>{observation.importance}</Text>
            )}
          </View>
          <Text style={[styles.prose, { color: colors.foreground }]}>{observation.note}</Text>
        </View>
      ))}
    </View>
  );
}

function ChapterView({ chapter, colors }: { chapter: Chapter; colors: Colors }) {
  return (
    <View style={[styles.chapter, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
      <View style={styles.chapterHeader}>
        <Icon name={ICON_NAMES[chapter.icon]} size={14} color={colors.foreground} />
        <Text style={[styles.chapterTitle, { color: colors.foreground }]}>{chapter.title}</Text>
      </View>
      {chapter.blurb ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{chapter.blurb}</Text> : null}
      {chapter.stops.map((stop) => (
        <StopView key={stop.id} stop={stop} colors={colors} />
      ))}
    </View>
  );
}

/** The contents of the document: the chapters and the stops they hold, in reading order. */
function ContentsView({ document, colors }: { document: WalkthroughDocument; colors: Colors }) {
  return (
    <View style={[styles.contents, { borderColor: colors.border }]}>
      <Text style={[styles.chapterTitle, { color: colors.foreground }]}>Contents</Text>
      {document.chapters.map((chapter) => (
        <View key={chapter.id} style={styles.contentsChapter}>
          <View style={styles.chapterHeader}>
            <Icon name={ICON_NAMES[chapter.icon]} size={12} color={colors.foregroundMuted} />
            <Text style={[styles.contentsChapterTitle, { color: colors.foreground }]}>{chapter.title}</Text>
          </View>
          {chapter.stops.map((stop) => (
            <Text key={stop.id} style={[styles.contentsStop, { color: colors.foregroundMuted }]}>
              {stop.title}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/** The files the walkthrough left out, each with the reason the model gave. */
function SkippedView({ document, colors }: { document: WalkthroughDocument; colors: Colors }) {
  if (document.routine.length === 0) return null;
  return (
    <View style={[styles.section, { borderColor: colors.border }]}>
      <Text style={[styles.chapterTitle, { color: colors.foreground }]}>Skipped files</Text>
      {document.routine.map((note) => (
        <View key={note.path} style={styles.routineRow}>
          <Text style={[styles.path, { color: colors.foreground }]}>{note.path}</Text>
          <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{note.note}</Text>
        </View>
      ))}
    </View>
  );
}

/** The hunks no stop covered: the reader still has to read them. */
function UncoveredView({ document, hunks, colors }: { document: WalkthroughDocument; hunks: Map<string, Hunk>; colors: Colors }) {
  if (document.uncoveredHunkIds.length === 0) return null;
  return (
    <View style={[styles.section, { borderColor: colors.border }]}>
      <Text style={[styles.chapterTitle, { color: colors.foreground }]}>Not covered by a stop</Text>
      <Text style={[styles.meta, { color: colors.foregroundMuted }]}>
        {`${document.uncoveredHunkIds.length} ${document.uncoveredHunkIds.length === 1 ? "hunk" : "hunks"} no stop explains.`}
      </Text>
      {document.uncoveredHunkIds.map((id) => {
        const hunk = hunks.get(id);
        if (!hunk) return null;
        return (
          <View key={id} style={styles.uncoveredHunk}>
            <Text style={[styles.path, { color: colors.foreground }]}>{hunk.path}</Text>
            <HunkView hunk={hunk} colors={colors} />
          </View>
        );
      })}
    </View>
  );
}

function DocumentView({ document, hunks, colors }: { document: WalkthroughDocument; hunks: Map<string, Hunk>; colors: Colors }) {
  return (
    <View style={styles.document}>
      <Text style={[styles.documentTitle, { color: colors.foreground }]}>{document.title}</Text>
      {document.focus ? <Text style={[styles.prose, { color: colors.foreground }]}>{document.focus}</Text> : null}
      <ContentsView document={document} colors={colors} />
      {document.chapters.map((chapter) => (
        <ChapterView key={chapter.id} chapter={chapter} colors={colors} />
      ))}
      <SkippedView document={document} colors={colors} />
      <UncoveredView document={document} hunks={hunks} colors={colors} />
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
    const [jobId, setJobId] = useState<string | null>(null);
    const [stage, setStage] = useState<WalkthroughJobState | null>(null);
    const [stages, setStages] = useState<WalkthroughJobState[]>([]);
    const [jobError, setJobError] = useState<string | null>(null);
    const [document, setDocument] = useState<WalkthroughDocument | null>(null);
    const [starting, setStarting] = useState(false);

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

    const loadStatus = useCallback(() => {
      client.rpc(statusRpc, { workspaceId, jobId }).then(
        (result) => {
          setStage(result.job?.state ?? null);
          setStages(result.job?.stages ?? []);
          setJobError(result.job?.error ?? null);
          setDocument(result.document);
          if (result.job && result.job.id !== jobId) setJobId(result.job.id);
        },
        () => undefined,
      );
    }, [client, workspaceId, jobId]);

    const running = stage !== null && RUNNING_STAGES.includes(stage);

    const hunks = useMemo(() => {
      const byId = new Map<string, Hunk>();
      for (const file of diff?.files ?? []) for (const hunk of file.hunks) byId.set(hunk.id, hunk);
      return byId;
    }, [diff]);

    useEffect(() => {
      loadStatus();
      if (!running) return;
      const timer = setInterval(loadStatus, STATUS_POLL_MS);
      return () => clearInterval(timer);
    }, [loadStatus, running]);

    const applyCommit = useCallback(() => setCommit(draft.trim()), [draft]);

    const generate = useCallback(() => {
      setStarting(true);
      client
        .rpc(generateRpc, { workspaceId, scope, ...(scope === "commit" ? { commit } : {}), model: null, language: "en" })
        .then(
          (result) => {
            setJobId(result.jobId);
            setJobError(null);
            setDocument(null);
            setStarting(false);
          },
          (cause: unknown) => {
            setJobError(cause instanceof Error ? cause.message : String(cause));
            setStarting(false);
          },
        );
    }, [client, workspaceId, scope, commit]);

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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Generate the walkthrough"
          accessibilityState={{ disabled: starting || running }}
          disabled={starting || running}
          onPress={generate}
          style={[styles.generate, { borderColor: colors.border, backgroundColor: running ? colors.surface2 : colors.accent }]}
        >
          <Text style={[styles.generateText, { color: running ? colors.foregroundMuted : colors.accentForeground }]}>
            {running ? "Generating..." : "Generate walkthrough"}
          </Text>
        </Pressable>
        {stage ? (
          <View style={styles.stages}>
            <Text style={[styles.stage, { color: colors.foreground }]}>{STAGE_LABELS[stage]}</Text>
            <View style={styles.trail}>
              {stages.map((entry, index) => (
                <Text key={`${entry}-${index}`} style={[styles.meta, { color: colors.foregroundMuted }]}>
                  {index > 0 ? " · " : ""}
                  {entry}
                </Text>
              ))}
            </View>
          </View>
        ) : null}
        {jobError ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{jobError}</Text> : null}
        {document ? <DocumentView document={document} hunks={hunks} colors={colors} /> : null}
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
  generate: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center" },
  generateText: { fontSize: 13, fontWeight: "600" },
  stages: { gap: 2 },
  stage: { fontSize: 13, fontWeight: "600" },
  trail: { flexDirection: "row", flexWrap: "wrap" },
  summary: { fontSize: 13, fontWeight: "600" },
  file: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  fileHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  path: { fontSize: 13, fontWeight: "600", flex: 1, minWidth: 0 },
  meta: { fontSize: 12 },
  hunk: { gap: 2 },
  hunkHeader: { fontSize: 11, fontFamily: "monospace" },
  code: { fontSize: 12, fontFamily: "monospace" },
  document: { gap: 10 },
  documentTitle: { fontSize: 16, fontWeight: "700" },
  contents: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 6 },
  contentsChapter: { gap: 2 },
  contentsChapterTitle: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  contentsStop: { fontSize: 12, paddingLeft: 16 },
  chapter: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  chapterHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  chapterTitle: { fontSize: 14, fontWeight: "700" },
  stop: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, gap: 4 },
  stopHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  stopTitle: { fontSize: 13, fontWeight: "600", flex: 1 },
  prose: { fontSize: 13 },
  observation: { borderRadius: 6, padding: 8, gap: 2 },
  observationHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  observationKind: { fontSize: 11, fontWeight: "700" },
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 6 },
  routineRow: { gap: 2 },
  uncoveredHunk: { gap: 4 },
});
