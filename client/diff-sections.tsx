import type { PluginTheme } from "@getpaseo/plugin";
import { Fragment, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DiffFile, DiffSection } from "../shared/types";

const SECTION_LABELS = { staged: "Staged", unstaged: "Unstaged" } as const;
const SECTIONS = ["staged", "unstaged"] as const;

export const sectionLabel = (section: DiffSection | undefined) => section && SECTION_LABELS[section];

export function DiffSections({ files, showSectionHeaders, colors, renderFile }: {
  files: DiffFile[];
  showSectionHeaders: boolean;
  colors: PluginTheme["colors"];
  renderFile: (file: DiffFile) => ReactNode;
}) {
  const renderFiles = (entries: DiffFile[]) => entries.map((file) => (
    <Fragment key={`${file.section ?? ""}:${file.path}`}>{renderFile(file)}</Fragment>
  ));

  if (!showSectionHeaders) return <>{renderFiles(files)}</>;

  return (
    <>
      {SECTIONS.map((section) => {
        const entries = files.filter((file) => file.section === section);
        if (entries.length === 0) return null;
        return (
          <View key={section} style={styles.section}>
            <Text accessibilityRole="header" style={[styles.heading, { color: colors.foreground }]}>
              {SECTION_LABELS[section]}
            </Text>
            {renderFiles(entries)}
          </View>
        );
      })}
      {renderFiles(files.filter((file) => !file.section))}
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  heading: { fontSize: 14, fontWeight: "600" },
});
