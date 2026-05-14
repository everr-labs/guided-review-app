type ChatScrollPosition = {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
};

const CHAT_BOTTOM_THRESHOLD_PX = 4;

export function isChatScrolledToBottom(
	position: ChatScrollPosition,
	thresholdPx = CHAT_BOTTOM_THRESHOLD_PX,
) {
	const hiddenBelowViewport =
		position.scrollHeight - position.clientHeight - position.scrollTop;
	return hiddenBelowViewport <= thresholdPx;
}
