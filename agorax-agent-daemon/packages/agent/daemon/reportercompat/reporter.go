package reportercompat

// Reporter is a no-op analytics sink for Agorax hosts that do not ship Agorax
// analytics. agentstatus treats a nil reporter as disabled.
type Reporter interface {
	Track(name string, params map[string]any)
}

type NopReporter struct{}

func (NopReporter) Track(string, map[string]any) {}
