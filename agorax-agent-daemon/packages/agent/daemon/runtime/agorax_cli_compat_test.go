package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

func textPrompt(text string) []PromptContentBlock {
	return []PromptContentBlock{{Type: "text", Text: text}}
}

func testRemotePromptImageMaterializer(t *testing.T) (string, providerPromptImageMaterializer) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/image.png" {
			http.Error(response, "unexpected request", http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "image/png")
		_, _ = response.Write([]byte("hi"))
	}))
	t.Cleanup(server.Close)
	return server.URL + "/image.png", func(ctx context.Context, content []PromptContentBlock) ([]PromptContentBlock, error) {
		return materializeProviderPromptImagesWithClient(ctx, content, server.Client())
	}
}

func testActiveAgoraxModeSnapshot() *AgoraxModeTurnSnapshot {
	return &AgoraxModeTurnSnapshot{
		ActivationID: "activation-1", RevisionID: "revision-7", Revision: 7,
		State: AgoraxModeStateActive, Source: "slash_command",
		PreferenceVersion: AgoraxModePreferenceVersionEffectSpeed,
		Effect: 80, Speed: 70, OrchestrationIntensity: 80,
	}
}

func claudeCodeModeFromID(optionID string) (bool, string, bool) {
	switch strings.TrimSpace(optionID) {
	case "plan":
		return true, "", true
	case "default", "acceptEdits", "dontAsk", "bypassPermissions":
		return false, strings.TrimSpace(optionID), true
	case "auto":
		return false, "acceptEdits", true
	default:
		return false, "", false
	}
}

func markClaudeSDKToolProgressUpdate(event *activityshared.Event) {
	if event == nil {
		return
	}
	if event.Payload.Metadata == nil {
		event.Payload.Metadata = map[string]any{}
	}
	event.Payload.Metadata[liveToolProgressMetadataKey] = true
}

type agoraxCLIProviderRejectedError struct{ providerError *AppError }

func (e *agoraxCLIProviderRejectedError) Error() string {
	if e == nil || e.providerError == nil { return "Claude provider rejected the Turn" }
	return e.providerError.Error()
}
func (e *agoraxCLIProviderRejectedError) Unwrap() error {
	if e == nil { return nil }
	return e.providerError
}

func newClaudeSDKProviderRejectedError(session Session, payload map[string]any) error {
	failure := claudeProviderFailure(payload)
	detail := sanitizeProviderFailureText(failure.Message)
	return &agoraxCLIProviderRejectedError{providerError: &AppError{
		Code: failure.Code, Message: visibleFailureContent(session.Provider, "turn", failure.Code),
		DebugMessage: detail, Cause: errors.New(detail),
	}}
}

var _ = json.Number("")
