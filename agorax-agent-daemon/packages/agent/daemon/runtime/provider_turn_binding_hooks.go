package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

const providerTurnBindingSchemaVersion = 1

type appServerProviderTurnBinding struct {
	SchemaVersion int `json:"schemaVersion"`
}

func (*CodexAppServerAdapter) WriteProviderTurnBinding(
	input ProviderTurnBindingWriteInput,
) (json.RawMessage, error) {
	if strings.TrimSpace(input.ProviderTurnID) == "" {
		return nil, errors.New("app-server provider turn id is required")
	}
	return json.Marshal(appServerProviderTurnBinding{
		SchemaVersion: providerTurnBindingSchemaVersion,
	})
}

func (*CodexAppServerAdapter) CanForkProviderTurn(
	_ context.Context,
	input ProviderTurnForkabilityInput,
) (bool, error) {
	if strings.TrimSpace(input.ProviderTurnID) == "" {
		return false, nil
	}
	var binding appServerProviderTurnBinding
	if err := json.Unmarshal(input.ProviderTurnBindingJSON, &binding); err != nil {
		return false, nil
	}
	return binding.SchemaVersion == providerTurnBindingSchemaVersion, nil
}

var (
	_ ProviderTurnBindingAdapter = (*CodexAppServerAdapter)(nil)
)

func (c *Controller) providerTurnBindingJSON(
	ctx context.Context,
	session Session,
	input ProviderTurnBindingWriteInput,
) json.RawMessage {
	if c == nil {
		return nil
	}
	adapter, err := c.resolveAdapter(ctx, AdapterResolveInput{
		Provider:          strings.TrimSpace(session.Provider),
		AgentTargetID:     session.AgentTargetID,
		CWD:               session.CWD,
		ProviderTargetRef: clonePayload(session.ProviderTargetRef),
	})
	if err != nil {
		return nil
	}
	writer, ok := adapter.(ProviderTurnBindingAdapter)
	if !ok {
		return nil
	}
	binding, err := writer.WriteProviderTurnBinding(input)
	if err != nil {
		return nil
	}
	return binding
}
