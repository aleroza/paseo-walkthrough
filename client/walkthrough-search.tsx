import { createContext, useCallback, useContext, type ComponentRef } from "react";
import { Text, type TextProps } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Hunk, WalkthroughDocument } from "../shared/types";

export function hunkBodyLines(hunk: Hunk) {
  const lines = hunk.patch.split("\n").slice(1);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export type WalkthroughMatch = {
  field: string;
  start: number;
  length: number;
  uncovered: boolean;
};

export function findWalkthroughMatches(
  document: WalkthroughDocument,
  hunks: Map<string, Hunk>,
  uncoveredHunks: readonly Hunk[],
  query: string,
): WalkthroughMatch[] {
  if (!query.trim()) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: WalkthroughMatch[] = [];

  function find(field: string, value: string, uncovered = false) {
    for (const match of value.matchAll(pattern)) {
      matches.push({ field, start: match.index, length: match[0].length, uncovered });
    }
  }

  function findHunk(field: string, hunk: Hunk, uncovered = false) {
    find(`${field}:header`, hunk.header, uncovered);
    hunkBodyLines(hunk).forEach((line, index) => find(`${field}:line:${index}`, line, uncovered));
  }

  find("document:title", document.title);
  find("document:focus", document.focus);
  for (const chapter of document.chapters) {
    const chapterField = `chapter:${chapter.id}`;
    find(`${chapterField}:title`, chapter.title);
    find(`${chapterField}:blurb`, chapter.blurb);
    for (const stop of chapter.stops) {
      const stopField = `stop:${stop.id}`;
      find(`${stopField}:title`, stop.title);
      find(`${stopField}:prose`, stop.prose);
      stop.observations.forEach((observation, index) => {
        const field = `${stopField}:observation:${index}`;
        find(`${field}:kind`, observation.kind);
        find(`${field}:note`, observation.note);
      });
      stop.hunkIds.forEach((id, index) => {
        const hunk = hunks.get(id);
        if (hunk) findHunk(`${stopField}:hunk:${index}`, hunk);
      });
    }
  }
  uncoveredHunks.forEach((hunk) => findHunk(`uncovered:hunk:${hunk.id}`, hunk, true));
  document.routine.forEach((note, index) => find(`uncovered:routine:${index}:note`, note.note, true));
  return matches;
}

export const searchAnchorId = (field: string) => `find:${field}`;

export const WalkthroughSearch = createContext<{
  match?: WalkthroughMatch;
  highlight: Pick<PluginTheme["colors"], "accent" | "accentForeground">;
  registerAnchor: (id: string, anchor: ComponentRef<typeof Text> | null) => void;
  refresh: () => void;
} | null>(null);

export function SearchText({ field, children, ...props }: Omit<TextProps, "children"> & {
  field?: string;
  children: string;
}) {
  const search = useContext(WalkthroughSearch);
  const match = search?.match;
  const registerAnchor = search?.registerAnchor;
  const ref = useCallback((anchor: ComponentRef<typeof Text> | null) => {
    if (field) registerAnchor?.(searchAnchorId(field), anchor);
  }, [field, registerAnchor]);
  if (!search || !match || match.field !== field) return <Text {...props}>{children}</Text>;

  const end = match.start + match.length;
  return (
    <Text
      {...props}
      ref={ref}
      onLayout={search.refresh}
    >
      {children.slice(0, match.start)}
      <Text style={{ backgroundColor: search.highlight.accent, color: search.highlight.accentForeground }}>
        {children.slice(match.start, end)}
      </Text>
      {children.slice(end)}
    </Text>
  );
}
