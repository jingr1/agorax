package agentstatus

import (
	"strings"
	"time"
)

func unsupportedProviderStatus(spec ProviderSpec, now time.Time) (ProviderStatus, bool) {
	if providerSupportStatus(spec) != ProviderSupportStatusUnsupported {
		return ProviderStatus{}, false
	}
	return ProviderStatus{
		Provider: spec.Provider,
		Availability: Availability{
			CheckedAt:  &now,
			ReasonCode: providerDisabledReasonCode(spec),
			Status:     AvailabilityUnsupported,
		},
		CLI: CLIStatus{
			Installed: false,
		},
		Adapter: AdapterStatus{
			Installed: false,
			Command:   cloneStrings(spec.AdapterCommand),
		},
		Auth: AuthInfo{
			Status: AuthUnknown,
		},
		Actions: []Action{},
	}, true
}

func unsupportedProviderProbeResult(spec ProviderSpec, now time.Time) (ProbeResult, bool) {
	if providerSupportStatus(spec) != ProviderSupportStatusUnsupported {
		return ProbeResult{}, false
	}
	return ProbeResult{
		Provider:   spec.Provider,
		Status:     ProbeSkipped,
		CheckedAt:  now,
		ReasonCode: providerDisabledReasonCode(spec),
		Message:    "Provider is temporarily unsupported",
		Command:    cloneStrings(spec.AdapterCommand),
	}, true
}

func unsupportedProviderRunActionResult(spec ProviderSpec, result RunActionResult) (RunActionResult, bool) {
	probe, ok := unsupportedProviderProbeResult(spec, result.CompletedAt)
	if !ok {
		return RunActionResult{}, false
	}
	result.Status = RunActionFailed
	result.ReasonCode = probe.ReasonCode
	result.Message = probe.Message
	result.Probe = &probe
	return result, true
}

func providerSupportStatus(spec ProviderSpec) ProviderSupportStatus {
	switch spec.SupportStatus {
	case ProviderSupportStatusUnsupported:
		return ProviderSupportStatusUnsupported
	default:
		return ProviderSupportStatusAvailable
	}
}

func providerDisabledReasonCode(spec ProviderSpec) string {
	reasonCode := strings.TrimSpace(spec.DisabledReasonCode)
	if reasonCode != "" {
		return reasonCode
	}
	return DisabledReasonProviderTemporarilyUnsupported
}
