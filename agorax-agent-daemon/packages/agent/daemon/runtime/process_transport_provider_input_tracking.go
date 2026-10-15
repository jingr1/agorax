package agentruntime

func (*RecordingProcessTransport) TracksProviderInputUnits() bool {
	return true
}

func (*ReplayProcessTransport) TracksProviderInputUnits() bool {
	return true
}

func (*SessionRecordingProcessTransport) TracksProviderInputUnits() bool {
	return true
}

func (*SessionReplayProcessTransport) TracksProviderInputUnits() bool {
	return true
}
