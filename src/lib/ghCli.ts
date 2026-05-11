import type { GhCliStatus } from "./acp";

export function ghCliNeedsInstallPopup(status: GhCliStatus | null): boolean {
	return status?.installed === false;
}

export function ghCliPopupMessage(status: GhCliStatus): string {
	return [
		"GitHub CLI is required for PR details and existing review comments.",
		status.error?.trim() || "Install GitHub CLI (`gh`) and restart the app.",
	].join("\n\n");
}
