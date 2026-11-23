import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useTabState } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { ComponentRef } from "react";
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
import { ToolbarSelect } from "./toolbar-select";
import { findWalkthroughMatches, hunkBodyLines, searchAnchorId, searchFields, SearchText, WalkthroughSearch, type WalkthroughMatch } from "./walkthrough-search";

const POLL_MS = 4_000;
const STATUS_POLL_MS = 1_500;
const MODELS_POLL_MS = 15_000;
const CONTENTS_MIN_PANEL_WIDTH = 720;

type Colors = PluginTheme["colors"];

const SOURCE_GROUPS = [
  { label: "Working tree", options: [
    { value: "all", label: "All uncommitted" },
    { value: "staged", label: "Staged" },
    { value: "unstaged", label: "Unstaged" },
  ] },
  { options: [{ value: "branch", label: "This branch" }] },
  { options: [{ value: "commit", label: "Commit" }] },
] as const;
const SOURCES = [
  ...SOURCE_GROUPS[0].options,
  ...SOURCE_GROUPS[1].options,
  ...SOURCE_GROUPS[2].options,
];
type ToolbarMenu = "scope" | "commit" | "model" | "language";

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
  disabled = false,
  expanded,
}: {
  label?: string;
  accessibilityLabel?: string;
  icon?: string;
  onPress: () => void;
  colors: Colors;
  disabled?: boolean;
  expanded?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const color = disabled ? colors.foregroundMuted : colors.foreground;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={({ pressed }) => [styles.action, {
        borderColor: focused ? colors.foreground : colors.border,
        backgroundColor: pressed || expanded ? colors.surface2 : colors.surface1,
      }]}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      {label ? <Text style={[styles.actionLabel, { color }]} numberOfLines={1}>{label}</Text> : null}
    </Pressable>
  );
}

function HunkView({ hunk, colors, field }: { hunk: Hunk; colors: Colors; field?: string }) {
  const fields = field ? searchFields.hunk(field) : undefined;
  return (
    <View style={styles.hunk}>
      <SearchText field={fields?.header} style={[styles.hunkHeader, { color: colors.foregroundMuted }]}>{hunk.header}</SearchText>
      {hunkBodyLines(hunk).map((line, index) => (
        <SearchText key={index} field={fields?.line(index)} selectable style={[styles.code, { color: lineColor(colors, line) }]}>
          {line.length > 0 ? line : " "}
        </SearchText>
      ))}
    </View>
  );
}

function DocumentHunkView({ hunk, previous = false, colors, field }: { hunk: Hunk; previous?: boolean; colors: Colors; field: string }) {
  const section = sectionLabel(hunk.section);
  return (
    <View style={[styles.documentHunk, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
      <Text style={[styles.hunkPath, { backgroundColor: colors.surface2, color: colors.foreground }]}>
        {section ? `${hunk.path} (${section})` : hunk.path}
        {previous ? " · Previous version" : null}
      </Text>
      <View style={styles.anchoredPatch}>
        <HunkView hunk={hunk} colors={colors} field={field} />
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
  const fields = searchFields.stop(stop.id);
  const heading = useCallback((view: ComponentRef<typeof View> | null) => {
    registerAnchor(stopAnchorId(stop.id), view);
  }, [registerAnchor, stop.id]);

  return (
    <View onLayout={refresh} style={[styles.stop, { borderColor: colors.border }]}>
      <View ref={heading} collapsable={false} onLayout={refresh} style={styles.stopHeader}>
        <SearchText field={fields.title} accessibilityRole="header" style={[styles.stopTitle, { color: colors.foreground }]}>{stop.title}</SearchText>
        {stop.importance === "normal" ? null : (
          <Text style={[styles.meta, { color: importanceColor(colors, stop.importance) }]}>{stop.importance}</Text>
        )}
        {stale ? <Text style={[styles.meta, { color: colors.statusWarning }]}>Out of date</Text> : null}
      </View>
      <SearchText field={fields.prose} style={[styles.prose, { color: colors.foreground }]}>{stop.prose}</SearchText>
      {stop.observations.map((observation, index) => (
        <View key={index} style={[styles.observation, { backgroundColor: colors.surface2 }]}>
          <View style={styles.observationHeader}>
            <Icon name={ICON_NAMES[observation.icon]} size={12} color={colors.accent} />
            <SearchText field={fields.observation(index).kind} style={[styles.observationKind, { color: colors.accent }]}>{observation.kind}</SearchText>
            {observation.importance === "normal" ? null : (
              <Text style={[styles.meta, { color: importanceColor(colors, observation.importance) }]}>{observation.importance}</Text>
            )}
          </View>
          <SearchText field={fields.observation(index).note} style={[styles.prose, { color: colors.foreground }]}>{observation.note}</SearchText>
        </View>
      ))}
      {stop.hunkIds.map((id, index) => {
        const hunk = hunks.get(id);
        return hunk ? <DocumentHunkView key={id} hunk={hunk} previous={outdatedHunks.has(id)} colors={colors} field={fields.hunk(index)} /> : null;
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
  const fields = searchFields.chapter(chapter.id);
  return (
    <View style={styles.chapter} onLayout={navigation.refresh}>
      <View style={styles.chapterHeader}>
        <Icon name={ICON_NAMES[chapter.icon]} size={14} color={colors.foreground} />
        <SearchText field={fields.title} accessibilityRole="header" style={[styles.chapterTitle, { color: colors.foreground }]}>{chapter.title}</SearchText>
      </View>
      {chapter.blurb ? <SearchText field={fields.blurb} style={[styles.meta, { color: colors.foregroundMuted }]}>{chapter.blurb}</SearchText> : null}
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
      {document.routine.map((note, index) => (
        <View key={note.path} style={styles.routineRow}>
          <Text style={[styles.path, { color: colors.foreground }]}>{note.path}</Text>
          <SearchText field={searchFields.routineNote(index)} style={[styles.meta, { color: colors.foregroundMuted }]}>{note.note}</SearchText>
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
      {open && hunks.map((hunk) => <DocumentHunkView key={hunk.id} hunk={hunk} colors={colors} field={searchFields.uncoveredHunk(hunk.id)} />)}
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
      <SearchText field={searchFields.documentTitle} accessibilityRole="header" style={[styles.documentTitle, { color: colors.foreground }]}>{document.title}</SearchText>
      {document.focus ? <SearchText field={searchFields.documentFocus} style={[styles.prose, { color: colors.foreground }]}>{document.focus}</SearchText> : null}
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

function DocumentReader({ document, staleness, hunks, colors, compact, query, setQuery }: DocumentReaderProps & {
  query: string;
  setQuery: (query: string) => void;
}) {
  const [width, setWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [uncoveredOpen, setUncoveredOpen] = useState(false);
  const [selection, setSelection] = useState<WalkthroughMatch>();
  const [stopIds] = useState(() => document.chapters.flatMap((chapter) => chapter.stops.map((stop) => stop.id)));
  const navigation = useReadingNavigation(stopIds);
  const { jumpTo, registerSearchAnchor, refresh } = navigation;
  const outdatedHunks = useMemo(() => new Set(staleness?.outdatedHunkIds ?? staleness?.missingHunkIds), [staleness]);
  const uncoveredHunks = useMemo(() => staleness?.currentUncoveredHunks ?? [...new Set(document.uncoveredHunkIds)].flatMap((id) => {
    const hunk = hunks.get(id);
    return hunk && !outdatedHunks.has(id) ? [hunk] : [];
  }), [document, hunks, outdatedHunks, staleness]);
  const matches = useMemo(() => findWalkthroughMatches(document, hunks, uncoveredHunks, query), [document, hunks, query, uncoveredHunks]);
  const currentIndex = Math.max(0, matches.findIndex((match) =>
    selection?.field === match.field && selection.start === match.start && selection.length === match.length,
  ));
  const match = matches[currentIndex];
  const search = { match, highlight: colors, registerSearchAnchor, refresh };
  const matchAnchor = match ? searchAnchorId(match) : null;
  const inUncoveredSection = match?.uncovered ?? false;

  const revealMatch = useCallback((anchor: string, uncovered: boolean) => {
    if (uncovered) setUncoveredOpen(true);
    jumpTo(anchor);
  }, [jumpTo]);

  useEffect(() => {
    if (matchAnchor) revealMatch(matchAnchor, inUncoveredSection);
  }, [matchAnchor, inUncoveredSection, query, revealMatch]);

  const moveMatch = (direction: number) => {
    if (!matches.length) return;
    const next = (currentIndex + direction + matches.length) % matches.length;
    const target = matches[next];
    setSelection(target);
    if (next === currentIndex) revealMatch(searchAnchorId(target), target.uncovered);
  };
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
      <View style={[styles.jumpBar, styles.searchBar, { borderColor: colors.border }]}>
        <TextInput
          accessibilityLabel="Find in walkthrough"
          placeholder="Find in walkthrough"
          placeholderTextColor={colors.foregroundMuted}
          value={query}
          onChangeText={(value) => {
            setSelection(undefined);
            setQuery(value);
          }}
          onSubmitEditing={() => moveMatch(1)}
          submitBehavior="submit"
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.commitInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 }]}
        />
        {query.trim() ? (
          <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: colors.foregroundMuted }]}>
            {match ? `${currentIndex + 1} of ${matches.length} ${matches.length === 1 ? "match" : "matches"}` : "No matches"}
          </Text>
        ) : null}
        <ToolbarButton accessibilityLabel="Previous match" icon="ChevronUp" colors={colors} disabled={!match} onPress={() => moveMatch(-1)} />
        <ToolbarButton accessibilityLabel="Next match" icon="ChevronDown" colors={colors} disabled={!match} onPress={() => moveMatch(1)} />
      </View>
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
          <WalkthroughSearch.Provider value={search}>
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
          </WalkthroughSearch.Provider>
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
  outsideRepository: boolean;
  colors: Colors;
};

function DiffSummary({ diff, base, error, empty, outsideRepository, colors }: DiffSummaryProps) {
  const fileCount = diff?.fileCount ?? 0;
  const hunkCount = diff?.hunkCount ?? 0;
  return (
    <>
      {error ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{error}</Text> : null}
      {diff || outsideRepository ? (
        <Text style={[styles.summary, { color: colors.foreground }]}>
          {`${fileCount} ${fileCount === 1 ? "file" : "files"}, ${hunkCount} ${hunkCount === 1 ? "hunk" : "hunks"}`}
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
    const [history, setHistory] = useState<{ commits: CommitOption[]; repository: boolean | null; error: string | null } | null>(null);
    const [diff, setDiff] = useState<Diff | null>(null);
    const [diffRefresh, setDiffRefresh] = useState(0);
    const [base, setBase] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [models, setModels] = useState<ModelOption[]>([]);
    const [defaultModel, setDefaultModel] = useState<string | null>(null);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);
    const [statusRefresh, setStatusRefresh] = useState(0);
    const statusVersion = useRef(0);
    const [stage, setStage] = useState<WalkthroughJobState | null>(null);
    const [stages, setStages] = useState<WalkthroughJobState[]>([]);
    const [jobError, setJobError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [displayed, setDisplayed] = useState<Pick<JobStatus, "document" | "staleness" | "hunks" | "source" | "documentMetadata">>();
    const [query, setQuery] = useState("");
    const { document, staleness = null, source, documentMetadata } = displayed ?? {};
    const [starting, setStarting] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [showCommitHash, setShowCommitHash] = useState(false);
    const [sourceDiffOpen, setSourceDiffOpen] = useState(false);
    const panel = useRef<ComponentRef<typeof View>>(null);
    const [panelWidth, setPanelWidth] = useState(0);
    const [openMenu, setOpenMenu] = useState<ToolbarMenu | null>(null);

    function menuProps(menu: ToolbarMenu) {
      return {
        colors, panel, panelWidth,
        open: openMenu === menu,
        setOpen: (open: boolean) => setOpenMenu(open ? menu : null),
      };
    }

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
          setDefaultModel(result.defaultModel);
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
          if (active) setHistory({ commits: [], repository: null, error: cause instanceof Error ? cause.message : String(cause) });
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
    }, [client, workspaceId, scope, commit, diffRefresh]);

    const running = stage !== null && RUNNING_STAGES.includes(stage);
    const regenerate =
      staleness?.stale === false &&
      source?.scope === scope &&
      (scope !== "commit" || source.commit === commit?.toLowerCase()) &&
      documentMetadata?.model === (model ?? defaultModel) &&
      documentMetadata?.language === language;

    const documentHunks = displayed?.hunks;
    const hunks = useMemo(() => new Map(documentHunks?.map((hunk) => [hunk.id, hunk])), [documentHunks]);
    const displayedSource = SOURCES.find(({ value }) => value === source?.scope)?.label ?? "Unknown source";
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
          force: regenerate,
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
    }, [client, workspaceId, scope, commit, model, language, regenerate, refreshStatus]);

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
      () => LANGUAGES.map((tag) => ({ label: tag === "ru" ? "Русский" : LANGUAGE_NAMES[tag], value: tag })),
      [],
    );

    const modelGone =
      model !== null && models.length > 0 && !models.some((option) => `${option.provider}/${option.id}` === model);
    const needsCommit = scope === "commit" && !commit;
    const outsideRepository = diff?.repository === false || (scope === "commit" && history?.repository === false);
    const historyError = scope === "commit" ? history?.error ?? null : null;
    const noChanges = !error && !needsCommit && !!diff?.repository && diff.files.length === 0 && (scope !== "branch" || !!base);
    const generateDisabled = starting || running || needsCommit || noChanges || outsideRepository;

    const empty = error
      ? null
      : outsideRepository
        ? "This workspace is not a git repository, so there is nothing to walk through."
        : needsCommit
          ? null
          : !diff
            ? PENDING[scope]
            : diff.files.length === 0
              ? scope === "branch" && !base
                ? NO_BASE
                : EMPTY[scope]
              : null;

    const sourceLabel = SOURCES.find(({ value }) => value === scope)?.label ?? scope;
    const diffSummary = { diff, base, error: error ?? historyError, empty, outsideRepository, colors };
    const narrowToolbar = panelWidth > 0 && panelWidth < 500;
    const modelLabel = models.find(({ provider, id }) => `${provider}/${id}` === model)?.label;
    const generateLabel = regenerate ? "Regenerate" : "Generate";
    const sourceDiffButton = (
      <ToolbarButton
        accessibilityLabel="View source diff"
        icon="FileDiff"
        colors={colors}
        disabled={needsCommit}
        onPress={() => {
          setOpenMenu(null);
          setSourceDiffOpen(true);
        }}
      />
    );

    return (
      <View ref={panel} collapsable={false} onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (width !== panelWidth) {
          setPanelWidth(width);
          setOpenMenu(null);
        }
      }} style={[styles.panel, { backgroundColor: colors.surface0 }]}>
        <View style={[styles.toolbar, { borderColor: colors.border }, openMenu && styles.toolbarActive]}>
          <View style={styles.toolbarRow}>
            <View style={[styles.actions, styles.toolbarGroup, (openMenu === "scope" || openMenu === "commit") && styles.toolbarGroupActive]}>
              <ToolbarSelect
                {...menuProps("scope")}
                label="Review scope"
                value={scope}
                groups={SOURCE_GROUPS}
                onChange={(value) => choose({ scope: value })}
              />
              {scope === "commit" ? (
                <>
                  <ToolbarSelect
                    {...menuProps("commit")}
                    label="Choose commit"
                    value={commit ?? ""}
                    groups={[{ options: commitOptions.filter(({ value }) => value !== "") }]}
                    displayValue={commit ? commit.slice(0, 8) : commitOptions[0]?.label}
                    menuWidth={360}
                    disabled={!history?.commits.length}
                    onChange={selectCommit}
                  />
                  <ToolbarButton
                    accessibilityLabel={showCommitHash ? "Hide hash input" : "Enter hash"}
                    icon="Hash"
                    colors={colors}
                    expanded={showCommitHash}
                    onPress={() => {
                      setOpenMenu(null);
                      setShowCommitHash((shown) => !shown);
                    }}
                  />
                </>
              ) : null}
              {narrowToolbar ? sourceDiffButton : null}
            </View>
            <View style={[styles.actions, styles.toolbarGroup, styles.toolbarEnd, (openMenu === "language" || openMenu === "model") && styles.toolbarGroupActive]}>
              <ToolbarSelect
                {...menuProps("language")}
                label="Language"
                icon="Globe"
                value={language}
                groups={[{ options: languageOptions }]}
                triggerWidth={narrowToolbar ? 104 : undefined}
                align="end"
                onChange={(value) => choose({ language: value })}
              />
              <ToolbarSelect
                {...menuProps("model")}
                label="Model"
                icon="Sparkles"
                value={model ?? ""}
                groups={[{ options: modelOptions }]}
                displayValue={model ? modelLabel ?? model : narrowToolbar ? "Default" : undefined}
                menuWidth={276}
                triggerWidth={narrowToolbar ? 108 : 220}
                align="end"
                onChange={(value) => choose({ model: value === "" ? null : value })}
              />
              {running && jobId ? (
                <ToolbarButton
                  label={cancelling ? "Cancelling…" : "Cancel"}
                  accessibilityLabel="Cancel the walkthrough"
                  icon="Square"
                  colors={colors}
                  disabled={cancelling}
                  onPress={cancel}
                />
              ) : (
                <ToolbarButton
                  label={starting ? "Generating…" : narrowToolbar ? generateLabel : `${generateLabel} walkthrough`}
                  accessibilityLabel={starting ? "Generating walkthrough" : `${generateLabel} walkthrough`}
                  icon={narrowToolbar ? undefined : "Workflow"}
                  colors={colors}
                  disabled={generateDisabled}
                  onPress={() => {
                    setOpenMenu(null);
                    generate();
                  }}
                />
              )}
              {narrowToolbar ? null : sourceDiffButton}
            </View>
          </View>
          {scope === "commit" ? (
            <>
              {showCommitHash ? (
                <View style={styles.commit}>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    onSubmitEditing={applyCommit}
                    accessibilityLabel="Full commit hash"
                    placeholder="Enter a full commit hash"
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
          {modelsError ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{modelsError}</Text> : null}
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
        {openMenu ? <Pressable accessible={false} tabIndex={-1} style={styles.dismissMenu} onPress={() => setOpenMenu(null)} /> : null}
        {document ? (
          <DocumentReader
            key={documentMetadata?.jobId ?? workspaceId}
            document={document}
            staleness={staleness}
            hunks={hunks}
            colors={colors}
            compact={layout.compact}
            query={query}
            setQuery={setQuery}
          />
        ) : noChanges && !historyError ? (
          <View style={styles.emptyState}>
            <Icon name="Info" size={23} color={colors.foregroundMuted} />
            <Text style={[styles.summary, { color: colors.foreground }]}>Nothing to review</Text>
            <Text style={[styles.emptyDescription, { color: colors.foregroundMuted }]}>There are no changes in this scope yet.</Text>
            <View>
              <ToolbarButton label="Refresh" colors={colors} onPress={() => setDiffRefresh((version) => version + 1)} />
            </View>
          </View>
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
  toolbarActive: { zIndex: 2 },
  toolbarRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 4 },
  toolbarGroup: { maxWidth: "100%" },
  toolbarGroupActive: { zIndex: 1 },
  toolbarEnd: { marginLeft: "auto", justifyContent: "flex-end" },
  dismissMenu: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, gap: 12 },
  emptyDescription: { textAlign: "center", fontSize: 13 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  action: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, minHeight: 33, maxWidth: "100%", borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 },
  actionLabel: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  reader: { flex: 1, minHeight: 0 },
  readerBody: { flex: 1, minHeight: 0, flexDirection: "row" },
  readingScroll: { flex: 1, minHeight: 0, minWidth: 0 },
  jumpBar: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 4 },
  searchBar: { flexDirection: "row", alignItems: "center", gap: 4 },
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
