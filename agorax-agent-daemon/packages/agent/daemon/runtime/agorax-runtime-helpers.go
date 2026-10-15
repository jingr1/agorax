package agentruntime

import (
	"encoding/json"
)

func payloadInt64(payload map[string]any, key string) int64 {
	switch value := payload[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		result, _ := value.Int64()
		return result
	default:
		return 0
	}
}

func cloneOptionalSessionSettings(settings *SessionSettings) *SessionSettings {
	if settings == nil {
		return nil
	}
	cloned := *settings
	if settings.BrowserUse != nil {
		value := *settings.BrowserUse
		cloned.BrowserUse = &value
	}
	if settings.ComputerUse != nil {
		value := *settings.ComputerUse
		cloned.ComputerUse = &value
	}
	return &cloned
}
