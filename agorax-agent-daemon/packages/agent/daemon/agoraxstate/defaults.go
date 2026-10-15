package agoraxstate

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type generatedDefaultsSpec struct {
	State             generatedStateDefaults
	Transport         generatedTransportDefaults
	Logging           generatedLoggingDefaults
	Analytics         generatedAnalyticsDefaults
	AgentExtensions   generatedAgentExtensionDefaults
	AgentRuntimeTools generatedAgentRuntimeToolDefaults
}

type generatedStateDefaults struct {
	ProductionDirName    string
	DevelopmentDirName   string
	RunDirName           string
	LogsDirName          string
	DBFileName           string
	DaemonLogFileName    string
	DesktopLogFileName   string
	ListenerInfoFileName string
	PIDFileName          string
}

type generatedTransportDefaults struct {
	DefaultTCPAddr string
}

type generatedLoggingDefaults struct {
	DefaultLevel  string
	DefaultOutput string
	MaxSizeMB     int
	MaxBackups    int
	MaxAgeDays    int
	MaxTotalMB    int
}

type generatedAnalyticsDefaults struct {
	AppID         int
	AppKey        string
	Channel       string
	ChannelDomain string
	AppVersion    string
}

type generatedAgentExtensionDefaults struct {
	Sources []generatedAgentExtensionSourceDefaults
}

type generatedAgentExtensionSourceDefaults struct {
	Key                      string
	PinnedVersion            string
	ReleaseIndexURL          string
	FallbackReleaseIndexURLs []string
	SigningKeyID             string
	SigningPublicKey         string
	Enabled                  bool
}

type AgentExtensionSource struct {
	Key                         string
	PinnedVersion               string
	ReleaseIndexURL             string
	FallbackReleaseIndexURLs    []string
	SigningKeyID                string
	SigningPublicKey            string
	LocalPackageDir             string
	LocalAccountUsageExecutable string
	Enabled                     bool
}

type generatedAgentRuntimeToolDefaults struct {
	UV generatedUVToolDefaults
}

type generatedUVToolDefaults struct {
	Version   string
	Artifacts []generatedUVToolArtifactDefaults
}

type generatedUVToolArtifactDefaults struct {
	Platform          string
	URL               string
	SHA256            string
	SizeBytes         int64
	Archive           string
	ArchiveExecutable string
}

// UVToolArtifact describes the pinned Agorax-managed uv toolchain archive for
// one platform.
type UVToolArtifact struct {
	Version           string
	Platform          string
	URL               string
	SHA256            string
	SizeBytes         int64
	Archive           string
	ArchiveExecutable string
}

type ResolvedDefaults struct {
	Runtime   RuntimeDefaults
	State     StateDefaults
	Transport TransportDefaults
	Logging   LoggingDefaults
}

type RuntimeDefaults struct {
	Env string
}

type StateDefaults struct {
	RootDir                string
	LogsDir                string
	RunDir                 string
	DaemonDBPath           string
	DaemonListenerInfoPath string
	DaemonLogPath          string
	DesktopLogPath         string
	DaemonPIDPath          string
}

type TransportDefaults struct {
	TCPAddr string
}

type LoggingDefaults struct {
	DefaultLevel  string
	DefaultOutput string
	MaxSizeMB     int
	MaxBackups    int
	MaxAgeDays    int
	MaxTotalMB    int
}

type AnalyticsConfig struct {
	Disabled      bool
	Debug         bool
	AppID         int
	AppKey        string
	Channel       string
	ChannelDomain string
	AppVersion    string
}

func ResolveDefaultsFromEnv() ResolvedDefaults {
	env := resolveAgoraxEnv()
	stateRootDir := resolveStateRootDir(env)
	logsDir := resolveLogsDir(stateRootDir)
	runDir := resolveRunDir(stateRootDir)

	return ResolvedDefaults{
		Runtime: RuntimeDefaults{
			Env: env,
		},
		State: StateDefaults{
			RootDir:                stateRootDir,
			LogsDir:                logsDir,
			RunDir:                 runDir,
			DaemonDBPath:           resolveDBPath(stateRootDir),
			DaemonListenerInfoPath: resolveListenerInfoPath(runDir),
			DaemonLogPath:          resolveDaemonLogPath(logsDir),
			DesktopLogPath:         resolveDesktopLogPath(logsDir),
			DaemonPIDPath:          resolvePIDPath(runDir),
		},
		Transport: TransportDefaults{
			TCPAddr: resolveTCPAddr(),
		},
		Logging: LoggingDefaults{
			DefaultLevel:  generatedDefaults.Logging.DefaultLevel,
			DefaultOutput: generatedDefaults.Logging.DefaultOutput,
			MaxSizeMB:     generatedDefaults.Logging.MaxSizeMB,
			MaxBackups:    generatedDefaults.Logging.MaxBackups,
			MaxAgeDays:    generatedDefaults.Logging.MaxAgeDays,
			MaxTotalMB:    generatedDefaults.Logging.MaxTotalMB,
		},
	}
}

func ResolveAnalyticsConfig() AnalyticsConfig {
	return AnalyticsConfig{
		Disabled:      resolveAnalyticsDisabled(),
		Debug:         resolveAnalyticsDebug(),
		AppID:         resolveAnalyticsAppID(),
		AppKey:        resolveStringOverride("AGORAX_ANALYTICS_APP_KEY", generatedDefaults.Analytics.AppKey),
		Channel:       generatedDefaults.Analytics.Channel,
		ChannelDomain: resolveStringOverride("AGORAX_ANALYTICS_CHANNEL_DOMAIN", generatedDefaults.Analytics.ChannelDomain),
		AppVersion:    resolveAnalyticsAppVersion(),
	}
}

func ResolveAppVersion() string {
	return resolveStringOverride("AGORAX_APP_VERSION", generatedDefaults.Analytics.AppVersion)
}

func ResolveAgentExtensionSources() []AgentExtensionSource {
	result := make([]AgentExtensionSource, 0, len(generatedDefaults.AgentExtensions.Sources))
	development := resolveAgoraxEnv() == "development"
	for _, source := range generatedDefaults.AgentExtensions.Sources {
		envPrefix := "AGORAX_AGENT_EXTENSION_" + strings.ToUpper(strings.ReplaceAll(source.Key, "-", "_"))
		localPackageDir := ""
		localAccountUsageExecutable := ""
		if development {
			localPackageDir = strings.TrimSpace(os.Getenv(envPrefix + "_PACKAGE_DIR"))
			localAccountUsageExecutable = strings.TrimSpace(os.Getenv(envPrefix + "_ACCOUNT_USAGE_EXECUTABLE"))
		}
		result = append(result, AgentExtensionSource{
			Key:                         source.Key,
			PinnedVersion:               source.PinnedVersion,
			ReleaseIndexURL:             source.ReleaseIndexURL,
			FallbackReleaseIndexURLs:    append([]string(nil), source.FallbackReleaseIndexURLs...),
			SigningKeyID:                source.SigningKeyID,
			SigningPublicKey:            source.SigningPublicKey,
			LocalPackageDir:             localPackageDir,
			LocalAccountUsageExecutable: localAccountUsageExecutable,
			Enabled:                     source.Enabled,
		})
	}
	return result
}

// ResolveUVToolArtifact returns the pinned Agorax-managed uv toolchain
// artifact for the given platform ("<goos>-<goarch>"), or ok=false when the
// platform is not covered or the pinned descriptor is invalid.
func ResolveUVToolArtifact(platform string) (UVToolArtifact, bool) {
	platform = strings.TrimSpace(platform)
	if platform == "" {
		return UVToolArtifact{}, false
	}
	version := strings.TrimSpace(generatedDefaults.AgentRuntimeTools.UV.Version)
	for _, artifact := range generatedDefaults.AgentRuntimeTools.UV.Artifacts {
		if artifact.Platform != platform {
			continue
		}
		resolved := UVToolArtifact{
			Version:           version,
			Platform:          artifact.Platform,
			URL:               strings.TrimSpace(artifact.URL),
			SHA256:            strings.TrimSpace(artifact.SHA256),
			SizeBytes:         artifact.SizeBytes,
			Archive:           strings.TrimSpace(artifact.Archive),
			ArchiveExecutable: strings.TrimSpace(artifact.ArchiveExecutable),
		}
		if !validUVToolArtifact(resolved) {
			return UVToolArtifact{}, false
		}
		return resolved, true
	}
	return UVToolArtifact{}, false
}

func validUVToolArtifact(artifact UVToolArtifact) bool {
	if artifact.Version == "" || artifact.Platform == "" || artifact.SizeBytes <= 0 {
		return false
	}
	if !strings.HasPrefix(artifact.URL, "https://") || strings.ContainsAny(artifact.URL, "?#@") {
		return false
	}
	if len(artifact.SHA256) != 64 {
		return false
	}
	for _, digit := range artifact.SHA256 {
		if (digit < '0' || digit > '9') && (digit < 'a' || digit > 'f') {
			return false
		}
	}
	if artifact.Archive != "tar.gz" && artifact.Archive != "zip" {
		return false
	}
	executable := artifact.ArchiveExecutable
	if executable == "" || strings.HasPrefix(executable, "/") || strings.Contains(executable, "\\") {
		return false
	}
	for _, component := range strings.Split(executable, "/") {
		if component == "" || component == "." || component == ".." {
			return false
		}
	}
	return true
}

func resolveAgoraxEnv() string {
	value := strings.ToLower(resolveStringOverride("AGORAX_ENV", ""))
	switch value {
	case "dev", "development", "local":
		return "development"
	default:
		return "production"
	}
}

func resolveStateRootDir(env string) string {
	override := resolveStringOverride("AGORAX_STATE_DIR", "")
	if override != "" {
		return override
	}

	homeDir, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(homeDir) == "" {
		if env == "development" {
			return generatedDefaults.State.DevelopmentDirName
		}
		return generatedDefaults.State.ProductionDirName
	}

	dirName := generatedDefaults.State.ProductionDirName
	if env == "development" {
		dirName = generatedDefaults.State.DevelopmentDirName
	}

	return filepath.Join(homeDir, dirName)
}

func resolveLogsDir(stateRootDir string) string {
	override := resolveStringOverride("AGORAX_LOG_DIR", "")
	if override != "" {
		return override
	}

	return filepath.Join(stateRootDir, generatedDefaults.State.LogsDirName)
}

func resolveRunDir(stateRootDir string) string {
	override := resolveStringOverride("AGORAX_AGENTD_RUN_DIR", "")
	if override != "" {
		return override
	}

	return filepath.Join(stateRootDir, generatedDefaults.State.RunDirName)
}

func resolveDBPath(stateRootDir string) string {
	override := resolveStringOverride("AGORAX_AGENTD_DB_PATH", "")
	if override != "" {
		return override
	}

	return filepath.Join(stateRootDir, generatedDefaults.State.DBFileName)
}

func resolveDaemonLogPath(logsDir string) string {
	override := resolveStringOverride("AGORAX_AGENTD_LOG_PATH", "")
	if override != "" {
		return override
	}

	return filepath.Join(logsDir, generatedDefaults.State.DaemonLogFileName)
}

func resolveDesktopLogPath(logsDir string) string {
	override := resolveStringOverride("AGORAX_DESKTOP_LOG_PATH", "")
	if override != "" {
		return override
	}

	return filepath.Join(logsDir, generatedDefaults.State.DesktopLogFileName)
}

func resolvePIDPath(runDir string) string {
	override := resolveStringOverride("AGORAX_AGENTD_PID_PATH", "")
	if override != "" {
		return override
	}

	return filepath.Join(runDir, generatedDefaults.State.PIDFileName)
}

func resolveListenerInfoPath(runDir string) string {
	override := resolveStringOverride("AGORAX_AGENTD_LISTENER_INFO_PATH", "")
	if override != "" {
		return override
	}

	return filepath.Join(runDir, generatedDefaults.State.ListenerInfoFileName)
}

func resolveTCPAddr() string {
	override := resolveStringOverride("AGORAX_AGENTD_ADDR", "")
	if override != "" {
		return override
	}

	return generatedDefaults.Transport.DefaultTCPAddr
}

func resolveAnalyticsDisabled() bool {
	value := strings.ToLower(resolveStringOverride("AGORAX_ANALYTICS_DISABLED", ""))
	switch value {
	case "":
		return false
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	default:
		return true
	}
}

func resolveAnalyticsDebug() bool {
	return resolveAgoraxEnv() == "development"
}

func resolveAnalyticsAppID() int {
	override := resolveStringOverride("AGORAX_ANALYTICS_APP_ID", "")
	if override == "" {
		return generatedDefaults.Analytics.AppID
	}

	value, err := strconv.Atoi(override)
	if err != nil || value <= 0 {
		return 0
	}
	return value
}

func resolveAnalyticsAppVersion() string {
	override := resolveStringOverride("AGORAX_ANALYTICS_APP_VERSION", "")
	if override != "" {
		return override
	}
	return ResolveAppVersion()
}

func resolveStringOverride(name string, fallback string) string {
	override := strings.TrimSpace(os.Getenv(name))
	if override != "" {
		return override
	}
	return fallback
}
