import type { ComponentRef } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView, View } from "react-native";

type Anchor = ComponentRef<typeof View>;

const READING_INSET = 24;

export const stopAnchorId = (stopId: string) => `stop:${stopId}`;

export function useReadingNavigation(stopIds: readonly string[]) {
  const scroll = useRef<ScrollView>(null);
  const content = useRef<Anchor>(null);
  const anchors = useRef(new Map<string, Anchor>());
  const stopPositions = useRef(new Map<string, number>());
  const layout = useRef({ offset: 0, viewportHeight: 0, contentHeight: 0 });
  const frame = useRef<number | null>(null);
  const pendingJump = useRef<string | null>(null);
  const landing = useRef<{ stopId: string; offset: number } | null>(null);
  const [activeStop, setActiveStop] = useState<string | null>(null);
  const [visitedStops, setVisitedStops] = useState<ReadonlySet<string>>(() => new Set());

  const updateStops = useCallback(() => {
    const { offset, viewportHeight } = layout.current;
    if (!viewportHeight) return;
    const reached = new Set<string>();
    let leading: string | null = null;
    let firstVisible: string | null = null;

    for (const stopId of stopIds) {
      const top = stopPositions.current.get(stopId);
      if (top === undefined) continue;
      if (top <= offset + READING_INSET) leading = stopId;
      if (top >= offset && top < offset + viewportHeight) {
        reached.add(stopId);
        firstVisible ??= stopId;
      }
    }

    const active = landing.current?.stopId ?? leading ?? firstVisible;
    if (active) reached.add(active);
    setActiveStop(active);
    if (reached.size) {
      setVisitedStops((visited) => [...reached].every((id) => visited.has(id)) ? visited : new Set([...visited, ...reached]));
    }
  }, [stopIds]);

  const refresh = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const root = content.current;
      if (!root) return;

      for (const stopId of stopIds) {
        anchors.current.get(stopAnchorId(stopId))?.measureLayout(root, (_x, y) => {
          stopPositions.current.set(stopId, y);
          updateStops();
        });
      }

      const id = pendingJump.current;
      if (id === null) return;
      anchors.current.get(id)?.measureLayout(root, (_x, y) => {
        if (pendingJump.current !== id) return;
        pendingJump.current = null;
        const { contentHeight, viewportHeight } = layout.current;
        const offset = Math.min(Math.max(0, y), Math.max(0, contentHeight - viewportHeight));
        const stopId = stopIds.find((stopId) => stopAnchorId(stopId) === id);
        landing.current = stopId ? { stopId, offset } : null;
        layout.current.offset = offset;
        scroll.current?.scrollTo({ y: offset, animated: false });
        updateStops();
      });
    });
  }, [stopIds, updateStops]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const registerAnchor = useCallback((id: string, anchor: Anchor | null) => {
    if (anchor) anchors.current.set(id, anchor);
    else anchors.current.delete(id);
    refresh();
  }, [refresh]);

  const jumpTo = useCallback((anchorId: string) => {
    pendingJump.current = anchorId;
    refresh();
  }, [refresh]);

  const onScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = nativeEvent.contentOffset.y;
    if (landing.current && Math.abs(landing.current.offset - offset) > 1) landing.current = null;
    layout.current.offset = offset;
    updateStops();
  };

  return {
    activeStop,
    visitedStops,
    jumpTo,
    registerAnchor,
    refresh,
    rootProps: { ref: content, collapsable: false, onLayout: refresh },
    scrollProps: {
      ref: scroll,
      onScroll,
      onContentSizeChange: (_width: number, height: number) => {
        layout.current.contentHeight = height;
        refresh();
      },
      onLayout: ({ nativeEvent }: import("react-native").LayoutChangeEvent) => {
        layout.current.viewportHeight = nativeEvent.layout.height;
        refresh();
      },
      scrollEventThrottle: 16,
    },
  };
}
