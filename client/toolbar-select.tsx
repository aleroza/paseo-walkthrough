import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ComponentRef, RefObject } from "react";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type Option<Value> = { value: Value; label: string };
type Group<Value> = { label?: string; options: readonly Option<Value>[] };
type Anchor = ComponentRef<typeof View>;
type KeyboardEvent = { key: string; preventDefault(): void; stopPropagation(): void };
type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

export function ToolbarSelect<Value extends string>({
  label, value, groups, displayValue, icon, colors, open, setOpen, onChange, panel, panelWidth,
  menuWidth = 216, triggerWidth, align = "start", disabled = false,
}: {
  label: string;
  value: Value;
  groups: readonly Group<Value>[];
  displayValue?: string;
  icon?: string;
  colors: PluginTheme["colors"];
  open: boolean;
  setOpen(open: boolean): void;
  onChange(value: Value): void;
  panel: RefObject<Anchor | null>;
  panelWidth: number;
  menuWidth?: number;
  triggerWidth?: number;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const anchor = useRef<Anchor>(null);
  const trigger = useRef<Anchor>(null);
  const rows = useRef(new Map<Value, Anchor>());
  const [left, setLeft] = useState(0);
  const width = Math.min(menuWidth, Math.max(0, panelWidth - 16));
  const options = groups.flatMap((group) => group.options);
  const selected = displayValue ?? options.find((option) => option.value === value)?.label;
  const color = disabled ? colors.foregroundMuted : colors.foreground;

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (!panel.current) return;
    anchor.current?.measureLayout(panel.current, (x, _y, anchorWidth) => {
      const preferredLeft = align === "end" ? x + anchorWidth - width : x;
      setLeft(Math.max(8, Math.min(preferredLeft, panelWidth - width - 8)) - x);
      setOpen(true);
    });
  }

  function handleKey(event: KeyboardEvent, from?: Value) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) {
      toggle();
      return;
    }
    const current = options.findIndex((option) => option.value === from);
    const step = event.key === "ArrowDown" ? 1 : -1;
    let index = (current + step + options.length) % options.length;
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = options.length - 1;
    else if (current === -1) index = Math.max(0, options.findIndex((option) => option.value === value));
    const next = options[index];
    if (next) rows.current.get(next.value)?.focus();
  }

  return (
    <View ref={anchor} collapsable={false} style={[styles.anchor, triggerWidth ? { maxWidth: triggerWidth } : null, open && styles.active]}>
      <Pressable
        ref={trigger}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected ?? ""}`}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={toggle}
        {...{ onKeyDown: (event: KeyboardEvent) => handleKey(event) }}
        style={({ pressed, hovered, focused }: PressState) => [styles.trigger, {
          borderColor: focused ? colors.foreground : colors.border,
          backgroundColor: open || pressed || hovered ? colors.surface2 : colors.surface1,
        }]}
      >
        {icon ? <Icon name={icon} size={15} color={color} /> : null}
        <Text numberOfLines={1} style={[styles.label, { color }]}>{selected}</Text>
        <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
      </Pressable>
      {open ? (
        <View style={[styles.menu, { left, width, backgroundColor: colors.surface1, borderColor: colors.border }]} accessibilityRole="menu">
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            {groups.map((group, index) => (
              <View key={index} style={[styles.group, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]}>
                {group.label ? <Text style={[styles.groupLabel, { color: colors.foregroundMuted }]}>{group.label}</Text> : null}
                {group.options.map((option) => (
                  <Pressable
                    key={option.value}
                    ref={(node) => {
                      if (node) rows.current.set(option.value, node);
                      else rows.current.delete(option.value);
                    }}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: option.value === value }}
                    onPress={() => {
                      close();
                      onChange(option.value);
                    }}
                    {...{ onKeyDown: (event: KeyboardEvent) => handleKey(event, option.value) }}
                    style={({ pressed, hovered, focused }: PressState) => [styles.item, {
                      backgroundColor: pressed || hovered || focused ? colors.surface2 : "transparent",
                    }]}
                  >
                    <Text numberOfLines={1} style={[styles.label, { color: colors.foreground }]}>{option.label}</Text>
                    {option.value === value ? <Icon name="Check" size={13} color={colors.foreground} /> : null}
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { alignSelf: "flex-start", maxWidth: "100%", flexShrink: 1 },
  active: { zIndex: 1 },
  trigger: { minHeight: 33, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 8, borderWidth: 1, borderRadius: 7 },
  label: { fontSize: 13, flexShrink: 1 },
  menu: {
    position: "absolute", top: "100%", marginTop: 3, borderWidth: 1, borderRadius: 12, overflow: "hidden",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 9, elevation: 5,
  },
  scroll: { maxHeight: 290 },
  group: { paddingVertical: 4 },
  groupLabel: { paddingHorizontal: 12, paddingVertical: 5, fontSize: 13 },
  item: { minHeight: 30, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
});
