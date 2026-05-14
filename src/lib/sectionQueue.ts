import type { ReviewSectionState, SectionState } from "./store";

export function findNextSectionToAutoLoad(
	sections: SectionState[],
	completedSectionId: string,
	processingSectionIds: string[],
): ReviewSectionState | null {
	const completedIndex = sections.findIndex(
		(section) => section.id === completedSectionId,
	);
	if (completedIndex < 0) return null;

	const processingIds = new Set(processingSectionIds);
	for (const section of sections.slice(completedIndex + 1)) {
		if (section.kind !== "review_section") continue;
		if (section.feedbackLoaded) continue;
		if (processingIds.has(section.id)) return null;
		return section;
	}

	return null;
}
