import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useTabState } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, SettingsSelect, TextInput } from "@getpaseo/plugin/client/ui";
import type { ComponentRef, Ref } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { cancelRpc, commitsRpc, diffRpc, generateRpc, modelsRpc, saveSettingsRpc, settingsRpc, statusRpc } from "../shared/contracts";
import type { ChapterIcon, StopImportance, WalkthroughJobState, WalkthroughScope } from "../shared/constants";
import { DEFAULT_PANEL_STATE, LANGUAGES, LANGUAGE_NAMES } from "../shared/constants";
import type { Chapter, CommitOption, Diff, DiffFile, Hunk, JobStatus, ModelOption, PanelState, Staleness, Stop, WalkthroughDocument } from "../shared/types";
import { panelStateSchema } from "../shared/types";
import { stopAnchorId, useReadingNavigation } from "./reading-navigation";
import { DiffSections, sectionLabel } from "./diff-sections";

const POLL_MS = 4_000;
const STATUS_POLL_MS = 1_500;
const MODELS_POLL_MS = 15_000;
const CONTENTS_MIN_PANEL_WIDTH = 720;

type Colors = PluginTheme["colors"];

const SOURCES: { scope: WalkthroughScope; label: string }[] = [
  { scope: "all", label: "All changes" },
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
  commit: "Reading the commit...",
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

function ToolbarButton({
  label,
  accessibilityLabel = label,
  icon,
  onPress,
  colors,
  primary = false,
  disabled = false,
  expanded,
  selected,
  buttonRef,
}: {
  label?: string;
  accessibilityLabel?: string;
  icon?: string;
  onPress: () => void;
  colors: Colors;
  primary?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  buttonRef?: Ref<ComponentRef<typeof View>>;
}) {
  const [focused, setFocused] = useState(false);
  const color = primary && !disabled ? colors.accentForeground : disabled ? colors.foregroundMuted : colors.foreground;

  return (
    <Pressable
      ref={buttonRef}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, expanded, selected }}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={({ pressed }) => [styles.action, {
        borderColor: focused ? colors.foreground : colors.border,
        backgroundColor: primary && !disabled ? colors.accent : pressed || expanded ? colors.surface2 : colors.surface1,
      }]}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      {label ? <Text style={[styles.actionLabel, { color }]} numberOfLines={1}>{label}</Text> : null}
    </Pressable>
  );
}

function HunkView({ hunk, colors }: { hunk: Hunk; colors: Colors }) {
  const body = hunk.patch.split("\n").slice(1);
  if (body.length > 0 && body[body.length - 1] === "") body.pop();
  return (
    <View style={styles.hunk}>
      <Text style={[styles.hunkHeader, { color: colors.foregroundMuted }]}>{hunk.header}</Text>
      {body.map((line, index) => (
        <Text key={index} selectable style={[styles.code, { color: lineColor(colors, line) }]}>
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </View>
  );
}

function DocumentHunkView({ hunk, previous = false, colors }: { hunk: Hunk; previous?: boolean; colors: Colors }) {
  const section = sectionLabel(hunk.section);
  return (
    <View style={[styles.documentHunk, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
      <Text style={[styles.hunkPath, { backgroundColor: colors.surface2, color: colors.foreground }]}>
        {section ? `${hunk.path} (${section})` : hunk.path}
        {previous ? " · Previous version" : null}
      </Text>
      <View style={styles.anchoredPatch}>
        <HunkView hunk={hunk} colors={colors} />
      </View>
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

type ReadingNavigation = ReturnType<typeof useReadingNavigation>;
type AnchorNavigation = Pick<ReadingNavigation, "registerAnchor" | "refresh">;

function StopView({ stop, stale, outdatedHunks, hunks, colors, navigation }: {
  stop: Stop;
  stale: boolean;
  outdatedHunks: Set<string>;
  hunks: Map<string, Hunk>;
  colors: Colors;
  navigation: AnchorNavigation;
}) {
  const { registerAnchor, refresh } = navigation;
  const heading = useCallback((view: ComponentRef<typeof View> | null) => {
    registerAnchor(stopAnchorId(stop.id), view);
  }, [registerAnchor, stop.id]);

  return (
    <View onLayout={refresh} style={[styles.stop, { borderColor: colors.border }]}>
      <View ref={heading} collapsable={false} onLayout={refresh} style={styles.stopHeader}>
        <Text accessibilityRole="header" style={[styles.stopTitle, { color: colors.foreground }]}>{stop.title}</Text>
        {stop.importance === "normal" ? null : (
          <Text style={[styles.meta, { color: importanceColor(colors, stop.importance) }]}>{stop.importance}</Text>
        )}
        {stale ? <Text style={[styles.meta, { color: colors.statusWarning }]}>Out of date</Text> : null}
      </View>
      <Text style={[styles.prose, { color: colors.foreground }]}>{stop.prose}</Text>
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
      {stop.hunkIds.map((id) => {
        const hunk = hunks.get(id);
        return hunk ? <DocumentHunkView key={id} hunk={hunk} previous={outdatedHunks.has(id)} colors={colors} /> : null;
      })}
    </View>
  );
}

function ChapterView({ chapter, staleStops, outdatedHunks, hunks, colors, navigation }: {
  chapter: Chapter;
  staleStops: Set<string>;
  outdatedHunks: Set<string>;
  hunks: Map<string, Hunk>;
  colors: Colors;
  navigation: AnchorNavigation;
}) {
  return (
    <View style={styles.chapter} onLayout={navigation.refresh}>
      <View style={styles.chapterHeader}>
        <Icon name={ICON_NAMES[chapter.icon]} size={14} color={colors.foreground} />
        <Text accessibilityRole="header" style={[styles.chapterTitle, { color: colors.foreground }]}>{chapter.title}</Text>
      </View>
      {chapter.blurb ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{chapter.blurb}</Text> : null}
      {chapter.stops.map((stop) => (
        <StopView
          key={stop.id}
          stop={stop}
          stale={staleStops.has(stop.id)}
          outdatedHunks={outdatedHunks}
          hunks={hunks}
          colors={colors}
          navigation={navigation}
        />
      ))}
    </View>
  );
}

function ContentsView({ document, colors, activeStop, visitedStops, onSelect }: {
  document: WalkthroughDocument;
  colors: Colors;
  activeStop: string | null;
  visitedStops: ReadonlySet<string>;
  onSelect: (stopId: string) => void;
}) {
  return (
    <View style={styles.contents}>
      {document.chapters.map((chapter) => (
        <View key={chapter.id} style={styles.contentsChapter}>
          <View style={styles.chapterHeader}>
            <Icon name={ICON_NAMES[chapter.icon]} size={12} color={colors.foregroundMuted} />
            <Text style={[styles.contentsChapterTitle, { color: colors.foreground }]}>{chapter.title}</Text>
          </View>
          {chapter.stops.map((stop) => {
            const selected = stop.id === activeStop;
            const visited = visitedStops.has(stop.id);
            return (
              <Pressable
                key={stop.id}
                accessibilityRole="button"
                accessibilityLabel={visited ? `${stop.title} (Visited)` : stop.title}
                accessibilityState={{ selected }}
                onPress={() => onSelect(stop.id)}
                style={({ pressed }) => [styles.contentsRow, {
                  backgroundColor: selected || pressed ? colors.surface2 : "transparent",
                  borderColor: selected ? colors.accent : "transparent",
                }]}
              >
                <View style={styles.contentsMarker}>
                  {visited ? <Icon name="Check" size={12} color={colors.statusSuccess} /> : null}
                </View>
                <Text style={[styles.contentsStop, { color: selected ? colors.foreground : colors.foregroundMuted }]}>{stop.title}</Text>
              </Pressable>
            );
          })}
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
function UncoveredView({ document, hunks, open, setOpen, colors }: {
  document: WalkthroughDocument;
  hunks: Hunk[];
  open: boolean;
  setOpen: (open: boolean) => void;
  colors: Colors;
}) {
  const count = hunks.length;
  if (count === 0 && document.routine.length === 0) return null;
  return (
    <View style={styles.contents}>
      <ToolbarButton
        label={count ? `Not covered · ${count} ${count === 1 ? "hunk" : "hunks"}` : "Not covered"}
        colors={colors}
        expanded={open}
        icon={open ? "ChevronDown" : "ChevronRight"}
        onPress={() => setOpen(!open)}
      />
      {open && hunks.map((hunk) => <DocumentHunkView key={hunk.id} hunk={hunk} colors={colors} />)}
      {open ? <SkippedView document={document} colors={colors} /> : null}
    </View>
  );
}

function StalenessView({
  document,
  staleness,
  staleStopIds,
  colors,
}: {
  document: WalkthroughDocument;
  staleness: Staleness | null;
  staleStopIds: Set<string>;
  colors: Colors;
}) {
  if (staleness?.stale === false) return null;
  const staleStops = document.chapters.flatMap((chapter) => chapter.stops).filter((stop) => staleStopIds.has(stop.id));

  return (
    <View style={[styles.section, { borderColor: colors.statusWarning }]}>
      <Text accessibilityRole="header" style={[styles.chapterTitle, { color: colors.statusWarning }]}>
        {staleness ? "The diff changed since this walkthrough" : "Could not check whether the diff changed"}
      </Text>
      {staleStops.length > 0 ? (
        <View style={styles.routineRow}>
          <Text style={[styles.chapterTitle, { color: colors.foreground }]}>Stale stops</Text>
          {staleStops.map((stop) => (
            <Text key={stop.id} style={[styles.meta, { color: colors.foreground }]}>{stop.title}</Text>
          ))}
        </View>
      ) : null}
      {([
        ["New hunks without a stop", staleness?.uncoveredHunks],
        ["Removed hunks", staleness?.missingHunks],
      ] as const).map(([label, locations]) => locations?.length ? (
        <View key={label} style={styles.routineRow}>
          <Text style={[styles.chapterTitle, { color: colors.foreground }]}>{label}</Text>
          {locations.map(({ id, path, section, header }) => {
            const label = sectionLabel(section);
            return <Text key={id} style={[styles.meta, { color: colors.foreground }]}>{label ? `${path} (${label})` : path} {header}</Text>;
          })}
        </View>
      ) : null)}
    </View>
  );
}

type DocumentReaderProps = {
  document: WalkthroughDocument;
  staleness: Staleness | null;
  hunks: Map<string, Hunk>;
  colors: Colors;
  compact: boolean;
};

function DocumentView({
  document,
  staleness,
  hunks,
  colors,
  compact,
  navigation,
  outdatedHunks,
  uncoveredHunks,
  uncoveredOpen,
  setUncoveredOpen,
}: DocumentReaderProps & {
  navigation: ReadingNavigation;
  outdatedHunks: Set<string>;
  uncoveredHunks: Hunk[];
  uncoveredOpen: boolean;
  setUncoveredOpen: (open: boolean) => void;
}) {
  const staleStopIds = new Set(staleness?.staleStopIds);
  return (
    <View {...navigation.rootProps} style={[styles.content, styles.document, compact && styles.contentCompact]}>
      <StalenessView document={document} staleness={staleness} staleStopIds={staleStopIds} colors={colors} />
      <Text accessibilityRole="header" style={[styles.documentTitle, { color: colors.foreground }]}>{document.title}</Text>
      {document.focus ? <Text style={[styles.prose, { color: colors.foreground }]}>{document.focus}</Text> : null}
      {document.chapters.map((chapter) => (
        <ChapterView
          key={chapter.id}
          chapter={chapter}
          staleStops={staleStopIds}
          outdatedHunks={outdatedHunks}
          hunks={hunks}
          colors={colors}
          navigation={navigation}
        />
      ))}
      <UncoveredView document={document} hunks={uncoveredHunks} open={uncoveredOpen} setOpen={setUncoveredOpen} colors={colors} />
    </View>
  );
}

function DocumentReader({ document, staleness, hunks, colors, compact }: DocumentReaderProps) {
  const [width, setWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [uncoveredOpen, setUncoveredOpen] = useState(false);
  const [stopIds] = useState(() => document.chapters.flatMap((chapter) => chapter.stops.map((stop) => stop.id)));
  const navigation = useReadingNavigation(stopIds);
  const outdatedHunks = new Set(staleness?.outdatedHunkIds ?? staleness?.missingHunkIds);
  const uncoveredHunks = staleness?.currentUncoveredHunks ?? [...new Set(document.uncoveredHunkIds)].flatMap((id) => {
    const hunk = hunks.get(id);
    return hunk && !outdatedHunks.has(id) ? [hunk] : [];
  });
  const showContents = stopIds.length > 0;
  const sideBySide = width >= CONTENTS_MIN_PANEL_WIDTH;
  const contents = showContents ? (
    <ContentsView document={document} colors={colors} activeStop={navigation.activeStop} visitedStops={navigation.visitedStops}
      onSelect={(stopId) => {
        setMenuOpen(false);
        navigation.jumpTo(stopAnchorId(stopId));
      }}
    />
  ) : null;

  return (
    <View style={styles.reader} onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
      {showContents && !sideBySide ? (
        <View style={[styles.jumpBar, { borderColor: colors.border }]}>
          <ToolbarButton label="Jump to stop" icon="List" expanded={menuOpen} colors={colors} onPress={() => setMenuOpen(true)} />
        </View>
      ) : null}
      <View style={styles.readerBody}>
        {showContents && sideBySide ? (
          <View style={[styles.contentsSidebar, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
            <Text accessibilityRole="header" style={[styles.contentsHeading, { color: colors.foreground }]}>Contents</Text>
            <ScrollView style={styles.readingScroll} contentContainerStyle={styles.contentsList}>
              {contents}
            </ScrollView>
          </View>
        ) : null}
        <ScrollView {...navigation.scrollProps} style={styles.readingScroll}>
          <DocumentView
            document={document}
            staleness={staleness}
            hunks={hunks}
            colors={colors}
            compact={compact}
            navigation={navigation}
            outdatedHunks={outdatedHunks}
            uncoveredHunks={uncoveredHunks}
            uncoveredOpen={uncoveredOpen}
            setUncoveredOpen={setUncoveredOpen}
          />
        </ScrollView>
      </View>
      <Modal title="Jump to stop" open={showContents && !sideBySide && menuOpen} onOpenChange={setMenuOpen}>
        {menuOpen && !sideBySide ? <Modal.Content contentContainerStyle={styles.contentsList}>{contents}</Modal.Content> : null}
      </Modal>
    </View>
  );
}

type DiffSummaryProps = {
  diff: Diff | null;
  base: string | null;
  error: string | null;
  empty: string | null;
  colors: Colors;
};

function DiffSummary({ diff, base, error, empty, colors }: DiffSummaryProps) {
  return (
    <>
      {error ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{error}</Text> : null}
      {diff ? (
        <Text style={[styles.summary, { color: colors.foreground }]}>
          {`${diff.fileCount} ${diff.fileCount === 1 ? "file" : "files"}, ${diff.hunkCount} ${diff.hunkCount === 1 ? "hunk" : "hunks"}`}
        </Text>
      ) : null}
      {base ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{`Compared against ${base}`}</Text> : null}
      {empty ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{empty}</Text> : null}
    </>
  );
}

function SourceDiff({ scope, ...props }: DiffSummaryProps & { scope: WalkthroughScope }) {
  const { diff, colors } = props;
  return (
    <>
      <DiffSummary {...props} />
      {diff ? (
        <DiffSections
          files={diff.files}
          showSectionHeaders={scope === "all"}
          colors={colors}
          renderFile={(file) => <FileView file={file} generated={diff.generatedPaths.includes(file.path)} colors={colors} />}
        />
      ) : null}
    </>
  );
}

export type CommandJobListener = (workspaceId: string, jobId: string) => void;

export function createDiffPanel(client: PluginClientContext, commandJobListeners: Set<CommandJobListener>) {
  function WalkthroughPanel({ workspaceId, theme, layout, tab }: PluginWorkspacePanelProps) {
    const colors = theme.colors;
    // The scope, the model and the language live in the panel state: the host keeps it per
    // workspace, and the plugin settings API is host scope on daemon 0.15.4.
    const [panelState, setPanelState] = useTabState(tab, panelStateSchema, DEFAULT_PANEL_STATE);
    const { scope, commit, model, language } = panelState;
    const storedState = useRef(tab.state);
    const [draft, setDraft] = useState(commit ?? "");
    const [history, setHistory] = useState<{ commits: CommitOption[]; error: string | null } | null>(null);
    const [diff, setDiff] = useState<Diff | null>(null);
    const [base, setBase] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [models, setModels] = useState<ModelOption[]>([]);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);
    const [statusRefresh, setStatusRefresh] = useState(0);
    const statusVersion = useRef(0);
    const [stage, setStage] = useState<WalkthroughJobState | null>(null);
    const [stages, setStages] = useState<WalkthroughJobState[]>([]);
    const [jobError, setJobError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [displayed, setDisplayed] = useState<Pick<JobStatus, "document" | "staleness" | "hunks" | "source" | "documentMetadata">>();
    const { document, staleness = null, source, documentMetadata } = displayed ?? {};
    const [starting, setStarting] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [openMenu, setOpenMenu] = useState<"source" | "options" | null>(null);
    const [sourceDiffOpen, setSourceDiffOpen] = useState(false);
    const sourceButton = useRef<ComponentRef<typeof View>>(null);

    const refreshStatus = useCallback(() => {
      statusVersion.current += 1;
      setStatusRefresh(statusVersion.current);
    }, []);

    useEffect(() => {
      const selectJob: CommandJobListener = (commandWorkspaceId) => {
        if (commandWorkspaceId !== workspaceId) return;
        setActionError(null);
        refreshStatus();
      };
      commandJobListeners.add(selectJob);
      return () => {
        commandJobListeners.delete(selectJob);
      };
    }, [commandJobListeners, refreshStatus, workspaceId]);

    const choose = useCallback(
      (next: Partial<PanelState>) => {
        const merged: PanelState = { ...panelState, ...next };
        storedState.current = merged;
        setPanelState(merged);
        void client.rpc(saveSettingsRpc, { workspaceId, settings: merged }).catch(() => undefined);
      },
      [client, workspaceId, panelState, setPanelState],
    );

    const loadModels = useCallback(() => {
      client.rpc(modelsRpc, { workspaceId }).then(
        (result) => {
          setModels(result.models);
          setModelsError(result.error);
        },
        (cause: unknown) => setModelsError(cause instanceof Error ? cause.message : String(cause)),
      );
    }, [client, workspaceId]);

    useEffect(() => {
      loadModels();
      const timer = setInterval(loadModels, MODELS_POLL_MS);
      return () => clearInterval(timer);
    }, [loadModels]);

    // A panel whose state the host never wrote takes the choice the server remembers for the
    // workspace; a panel that has a state of its own keeps it.
    useEffect(() => {
      let cancelled = false;
      client.rpc(settingsRpc, { workspaceId }).then(
        (result) => {
          if (cancelled) return;
          if (storedState.current !== undefined) return;
          setPanelState(result.settings);
          if (result.settings.commit !== undefined) setDraft(result.settings.commit);
        },
        () => undefined,
      );
      return () => {
        cancelled = true;
      };
    }, [client, workspaceId, setPanelState]);

    useEffect(() => {
      if (scope !== "commit") return;
      let active = true;
      setHistory(null);
      client.rpc(commitsRpc, { workspaceId }).then(
        (result) => {
          if (active) setHistory(result);
        },
        (cause: unknown) => {
          if (active) setHistory({ commits: [], error: cause instanceof Error ? cause.message : String(cause) });
        },
      );
      return () => {
        active = false;
      };
    }, [client, workspaceId, scope]);

    useEffect(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      setDiff(null);
      setBase(null);
      setError(null);

      async function loadDiff() {
        try {
          const result = await client.rpc(diffRpc, { workspaceId, scope, ...(scope === "commit" ? { commit } : {}) });
          if (!active) return;
          setDiff(result.diff);
          setBase(result.base ?? null);
          setError(result.error);
        } catch (cause) {
          if (!active) return;
          setDiff(null);
          setBase(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (active) timer = setTimeout(loadDiff, POLL_MS);
        }
      }

      if (scope !== "commit" || commit) void loadDiff();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [client, workspaceId, scope, commit]);

    const running = stage !== null && RUNNING_STAGES.includes(stage);

    const documentHunks = displayed?.hunks;
    const hunks = useMemo(() => new Map(documentHunks?.map((hunk) => [hunk.id, hunk])), [documentHunks]);
    const displayedSource = SOURCES.find(({ scope }) => scope === source?.scope)?.label ?? "Unknown source";
    const displayedCommit = source?.scope === "commit" ? ` ${source.commit ?? "unknown"}` : "";
    const displayedModel = documentMetadata?.model ?? "Unknown model";
    const displayedLanguage = documentMetadata?.language ? LANGUAGE_NAMES[documentMetadata.language] : "Unknown language";
    const documentDetails = `Showing ${displayedSource}${displayedCommit} · ${displayedModel} · ${displayedLanguage}`;

    useEffect(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const current = () => active && statusVersion.current === statusRefresh;

      async function loadStatus() {
        try {
          const result = await client.rpc(statusRpc, { workspaceId, jobId: null });
          if (!current()) return;
          setJobId(result.job?.id ?? null);
          setStage(result.job?.state ?? null);
          setStages(result.job?.stages ?? []);
          setJobError(result.job?.error ?? null);
          if (result.document) setDisplayed(result);
          if (result.job && RUNNING_STAGES.includes(result.job.state)) {
            timer = setTimeout(loadStatus, STATUS_POLL_MS);
          } else if (result.document) {
            timer = setTimeout(loadStatus, POLL_MS);
          }
        } catch {
          if (!current()) return;
          timer = setTimeout(loadStatus, POLL_MS);
        }
      }

      void loadStatus();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [client, workspaceId, statusRefresh]);

    const selectCommit = (hash: string) => {
      setDraft(hash);
      choose({ commit: hash });
    };

    const commitOptions = (history?.commits ?? []).map(({ hash, subject }) => ({
      value: hash,
      label: subject ? `${hash.slice(0, 8)} · ${subject}` : hash.slice(0, 8),
    }));
    if (commit && !commitOptions.some(({ value }) => value === commit)) {
      commitOptions.unshift({ value: commit, label: commit.slice(0, 8) });
    }
    if (!commit) {
      const label = !history ? "Loading commits..." : commitOptions.length ? "Select a commit" : "No commits available";
      commitOptions.unshift({ value: "", label });
    }

    const applyCommit = () => {
      const hash = draft.trim().toLowerCase();
      if (hash) selectCommit(hash);
    };

    const generate = useCallback(() => {
      setStarting(true);
      setActionError(null);
      client
        .rpc(generateRpc, {
          workspaceId,
          scope,
          ...(scope === "commit" ? { commit } : {}),
          model,
          language,
        })
        .then(
          () => {
            refreshStatus();
            setStarting(false);
          },
          (cause: unknown) => {
            setActionError(cause instanceof Error ? cause.message : String(cause));
            setStarting(false);
          },
        );
    }, [client, workspaceId, scope, commit, model, language, refreshStatus]);

    const cancel = useCallback(() => {
      if (!jobId) return;
      setCancelling(true);
      setActionError(null);
      client.rpc(cancelRpc, { workspaceId, jobId }).then(
        (result) => {
          setCancelling(false);
          if (result.error) setActionError(result.error);
          refreshStatus();
        },
        (cause: unknown) => {
          setCancelling(false);
          setActionError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    }, [client, workspaceId, jobId, refreshStatus]);

    const modelOptions = useMemo(
      () => [
        { label: "Default model", value: "" },
        ...models.map((option) => ({
          label: `${option.label} (${option.provider})`,
          value: `${option.provider}/${option.id}`,
        })),
      ],
      [models],
    );

    const languageOptions = useMemo(
      () => LANGUAGES.map((tag) => ({ label: LANGUAGE_NAMES[tag], value: tag })),
      [],
    );

    const modelGone =
      model !== null && models.length > 0 && !models.some((option) => `${option.provider}/${option.id}` === model);
    const needsCommit = scope === "commit" && !commit;
    const generateDisabled = starting || running || needsCommit;

    const empty = error || needsCommit
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

    const sourceLabel = SOURCES.find((source) => source.scope === scope)?.label ?? scope;
    const sourceMenuOpen = openMenu === "source";
    const optionsOpen = openMenu === "options";
    const diffSummary = { diff, base, error, empty, colors };

    return (
      <View style={[styles.panel, { backgroundColor: colors.surface0 }]}>
        <View style={[styles.toolbar, { borderColor: colors.border }]}>
          <View style={styles.actions}>
            <ToolbarButton
              label={sourceLabel}
              accessibilityLabel={`Source: ${sourceLabel}`}
              icon={sourceMenuOpen ? "ChevronUp" : "ChevronDown"}
              colors={colors}
              expanded={sourceMenuOpen}
              buttonRef={sourceButton}
              onPress={() => setOpenMenu(sourceMenuOpen ? null : "source")}
            />
            <ToolbarButton
              label={starting || running ? "Generating…" : "Generate"}
              accessibilityLabel={starting || running ? "Generating the walkthrough" : "Generate the walkthrough"}
              colors={colors}
              primary
              disabled={generateDisabled}
              onPress={generate}
            />
            {running && jobId ? (
              <ToolbarButton
                label={cancelling ? "Cancelling…" : "Cancel"}
                accessibilityLabel="Cancel the walkthrough"
                colors={colors}
                disabled={cancelling}
                onPress={cancel}
              />
            ) : null}
            <ToolbarButton
              label="Diff"
              accessibilityLabel="View source diff"
              icon="FileDiff"
              colors={colors}
              disabled={needsCommit}
              onPress={() => setSourceDiffOpen(true)}
            />
            <ToolbarButton
              accessibilityLabel="Walkthrough options"
              icon="Settings"
              colors={colors}
              expanded={optionsOpen}
              onPress={() => setOpenMenu(optionsOpen ? null : "options")}
            />
          </View>
          {sourceMenuOpen ? (
            <View style={styles.actions}>
              {SOURCES.map((source) => (
                <ToolbarButton
                  key={source.scope}
                  label={source.label}
                  colors={colors}
                  primary={source.scope === scope}
                  selected={source.scope === scope}
                  onPress={() => {
                    choose({ scope: source.scope });
                    sourceButton.current?.focus();
                    setOpenMenu(null);
                  }}
                />
              ))}
            </View>
          ) : null}
          {scope === "commit" ? (
            <>
              <SettingsSelect
                label="Commit"
                value={commit ?? ""}
                options={commitOptions}
                disabled={!history?.commits.length}
                error={history?.error}
                onValueChange={(hash) => {
                  if (hash) selectCommit(hash);
                }}
              />
              {!document || sourceMenuOpen ? (
                <View style={styles.commit}>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    onSubmitEditing={applyCommit}
                    accessibilityLabel="Full commit hash"
                    placeholder="Or enter a full commit hash"
                    placeholderTextColor={colors.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.commitInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 }]}
                  />
                  <ToolbarButton label="Show" accessibilityLabel="Show the commit" colors={colors} onPress={applyCommit} />
                </View>
              ) : null}
            </>
          ) : null}
          {optionsOpen ? (
            <View style={[styles.options, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
              <SettingsSelect
                label="Model"
                value={model ?? ""}
                options={modelOptions}
                onValueChange={(value) => choose({ model: value === "" ? null : value })}
              />
              <SettingsSelect
                label="Language"
                value={language}
                options={languageOptions}
                onValueChange={(value) => choose({ language: value })}
              />
            </View>
          ) : null}
          {modelsError && (optionsOpen || !document) ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{modelsError}</Text> : null}
          {modelGone ? (
            <Text style={[styles.meta, { color: colors.statusWarning }]}>The selected model is unavailable.</Text>
          ) : null}
          {stage && (stage !== "done" || !document) ? (
            <View style={styles.stages} accessibilityLiveRegion="polite">
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
          {actionError || jobError ? (
            <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: colors.statusDanger }]}>{actionError ?? jobError}</Text>
          ) : null}
          {document ? <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{documentDetails}</Text> : null}
        </View>
        {document ? (
          <DocumentReader key={documentMetadata?.jobId ?? workspaceId} document={document} staleness={staleness} hunks={hunks} colors={colors} compact={layout.compact} />
        ) : (
          <ScrollView style={styles.readingScroll} contentContainerStyle={[styles.content, layout.compact && styles.contentCompact]}>
            <DiffSummary {...diffSummary} />
          </ScrollView>
        )}
        <Modal title={`Source diff · ${sourceLabel}`} open={sourceDiffOpen} onOpenChange={setSourceDiffOpen}>
          {sourceDiffOpen ? (
            <Modal.Content contentContainerStyle={[styles.content, layout.compact && styles.contentCompact]}>
              <SourceDiff {...diffSummary} scope={scope} />
            </Modal.Content>
          ) : null}
        </Modal>
      </View>
    );
  }

  return function WorkspaceWalkthroughPanel(props: PluginWorkspacePanelProps) {
    return <WalkthroughPanel key={props.workspaceId} {...props} />;
  };
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, minWidth: 0 },
  toolbar: { borderBottomWidth: StyleSheet.hairlineWidth, padding: 8, gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  action: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, minHeight: 30, maxWidth: "100%", borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 },
  actionLabel: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  options: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 8 },
  reader: { flex: 1, minHeight: 0 },
  readerBody: { flex: 1, minHeight: 0, flexDirection: "row" },
  readingScroll: { flex: 1, minHeight: 0, minWidth: 0 },
  jumpBar: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 4 },
  content: { padding: 16, gap: 10 },
  contentCompact: { padding: 10 },
  commit: { flexDirection: "row", alignItems: "center", gap: 8 },
  commitInput: { flex: 1, minWidth: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 12 },
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
  document: { gap: 12 },
  documentTitle: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  contents: { gap: 6 },
  contentsSidebar: { width: 208, minHeight: 0, borderRightWidth: StyleSheet.hairlineWidth },
  contentsHeading: { paddingHorizontal: 12, paddingTop: 10, fontSize: 14, fontWeight: "700" },
  contentsList: { padding: 10 },
  contentsChapter: { gap: 2 },
  contentsChapterTitle: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  contentsRow: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 30, paddingHorizontal: 5, paddingVertical: 4, borderRadius: 5, borderWidth: 1 },
  contentsMarker: { width: 12 },
  contentsStop: { fontSize: 12, flexShrink: 1 },
  chapter: { gap: 8 },
  chapterHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  chapterTitle: { fontSize: 14, fontWeight: "700", flexShrink: 1 },
  stop: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 8, gap: 6 },
  stopHeader: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 6 },
  stopTitle: { fontSize: 13, fontWeight: "700", flexGrow: 1, flexShrink: 1 },
  prose: { fontSize: 13, lineHeight: 19 },
  observation: { borderRadius: 6, padding: 8, gap: 2 },
  observationHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  observationKind: { fontSize: 11, fontWeight: "700" },
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 6 },
  routineRow: { gap: 2 },
  documentHunk: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, overflow: "hidden" },
  hunkPath: { fontSize: 12, fontFamily: "monospace", paddingHorizontal: 8, paddingVertical: 5 },
  anchoredPatch: { padding: 8 },
});
