import { createContext, useContext, useLayoutEffect, useRef, type ComponentRef } from "react";
import { Text, type TextProps } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Hunk, WalkthroughDocument } from "../shared/types";
import type { MeasureAnchor } from "./reading-navigation";

export const searchFields = {
  documentTitle: "document:title",
  documentFocus: "document:focus",
  chapter: (id: string) => ({ title: `chapter:${id}:title`, blurb: `chapter:${id}:blurb` }),
  stop: (id: string) => ({
    title: `stop:${id}:title`,
    prose: `stop:${id}:prose`,
    observation: (index: number) => ({
      kind: `stop:${id}:observation:${index}:kind`,
      note: `stop:${id}:observation:${index}:note`,
    }),
    hunk: (index: number) => `stop:${id}:hunk:${index}`,
  }),
  hunk: (field: string) => ({ header: `${field}:header`, line: (index: number) => `${field}:line:${index}` }),
  uncoveredHunk: (id: string) => `uncovered:hunk:${id}`,
  routineNote: (index: number) => `uncovered:routine:${index}:note`,
};

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
    const fields = searchFields.hunk(field);
    find(fields.header, hunk.header, uncovered);
    hunkBodyLines(hunk).forEach((line, index) => find(fields.line(index), line, uncovered));
  }

  find(searchFields.documentTitle, document.title);
  find(searchFields.documentFocus, document.focus);
  for (const chapter of document.chapters) {
    const chapterFields = searchFields.chapter(chapter.id);
    find(chapterFields.title, chapter.title);
    find(chapterFields.blurb, chapter.blurb);
    for (const stop of chapter.stops) {
      const stopFields = searchFields.stop(stop.id);
      find(stopFields.title, stop.title);
      find(stopFields.prose, stop.prose);
      stop.observations.forEach((observation, index) => {
        const fields = stopFields.observation(index);
        find(fields.kind, observation.kind);
        find(fields.note, observation.note);
      });
      stop.hunkIds.forEach((id, index) => {
        const hunk = hunks.get(id);
        if (hunk) findHunk(stopFields.hunk(index), hunk);
      });
    }
  }
  uncoveredHunks.forEach((hunk) => findHunk(searchFields.uncoveredHunk(hunk.id), hunk, true));
  document.routine.forEach((note, index) => find(searchFields.routineNote(index), note.note, true));
  return matches;
}

export const searchAnchorId = ({ field, start, length }: WalkthroughMatch) => `find:${field}:${start}:${length}`;

type SearchNavigation = {
  highlight: Pick<PluginTheme["colors"], "accent" | "accentForeground">;
  registerSearchAnchor: (id: string, measure: MeasureAnchor | null) => void;
  refresh: () => void;
};

export const WalkthroughSearch = createContext<(SearchNavigation & {
  match?: WalkthroughMatch;
}) | null>(null);

export function SearchText({ field, children, ...props }: Omit<TextProps, "children"> & {
  field?: string;
  children: string;
}) {
  const search = useContext(WalkthroughSearch);
  if (!search?.match || search.match.field !== field) return <Text {...props}>{children}</Text>;
  return <MatchedText {...props} search={search} match={search.match}>{children}</MatchedText>;
}

function MatchedText({ children, search, match, onLayout, onTextLayout, ...props }: Omit<TextProps, "children"> & {
  children: string;
  search: SearchNavigation;
  match: WalkthroughMatch;
}) {
  const { registerSearchAnchor, refresh } = search;
  const text = useRef<ComponentRef<typeof Text>>(null);
  const highlight = useRef<ComponentRef<typeof Text>>(null);
  const lines = useRef<Parameters<NonNullable<TextProps["onTextLayout"]>>[0]["nativeEvent"]["lines"]>([]);
  const { start, length } = match;
  const id = searchAnchorId(match);

  useLayoutEffect(() => {
    registerSearchAnchor(id, (root, measured) => {
      const rootElement = root as unknown as Partial<HTMLElement>;
      const highlightElement = highlight.current as unknown as Partial<HTMLElement> | null;
      if (rootElement.getBoundingClientRect && highlightElement?.getClientRects) {
        const first = highlightElement.getClientRects()[0];
        if (first) measured(first.top - rootElement.getBoundingClientRect().top);
        return;
      }

      // Native inline Text has no view of its own. Use the paragraph's measured line origins.
      if (!lines.current.length) return;
      let offset = 0;
      for (const line of lines.current) {
        const lineStart = line.text ? children.indexOf(line.text, offset) : offset;
        if (lineStart < 0) break;
        offset = lineStart + line.text.length;
        if (offset > start) {
          text.current?.measureLayout(root, (_x, y) => measured(y + line.y));
          return;
        }
      }
      text.current?.measureLayout(root, (_x, y) => measured(y));
    });
    return () => registerSearchAnchor(id, null);
  }, [children, id, registerSearchAnchor, start]);

  return (
    <Text
      {...props}
      ref={text}
      onLayout={(event) => {
        onLayout?.(event);
        refresh();
      }}
      onTextLayout={(event) => {
        lines.current = event.nativeEvent.lines;
        onTextLayout?.(event);
        refresh();
      }}
    >
      {children.slice(0, start)}
      <Text ref={highlight} style={{ backgroundColor: search.highlight.accent, color: search.highlight.accentForeground }}>
        {children.slice(start, start + length)}
      </Text>
      {children.slice(start + length)}
    </Text>
  );
}
