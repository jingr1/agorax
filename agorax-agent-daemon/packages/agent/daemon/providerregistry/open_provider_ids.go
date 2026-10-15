package providerregistry

import (
	"regexp"
	"strings"
)

var openProviderIDPattern = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,127}$`)

// NormalizeOpenProviderID preserves registered-provider alias handling while
// accepting extension-owned provider identities such as acp:gemini. The
// normalized identity is metadata only; callers must still resolve an
// authoritative Agent Target before launching an extension runtime.
func NormalizeOpenProviderID(value string) (string, bool) {
	if providerID, ok := ResolveProviderID(value); ok {
		return providerID, true
	}
	value = strings.TrimSpace(value)
	if !openProviderIDPattern.MatchString(value) {
		return "", false
	}
	return value, true
}
