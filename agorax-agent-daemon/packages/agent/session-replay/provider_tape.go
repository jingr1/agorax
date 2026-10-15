package sessionreplay

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	ProcessCassetteSchemaVersion     = 4
	ProcessCassetteProjectionVersion = 1
	PortableReplayHomeToken          = "${REPLAY_HOME}"
)

var ErrProcessCassetteSizeLimit = errors.New("process cassette size limit exceeded")

type ProcessCassetteStatus string

const (
	ProcessCassetteStatusIncomplete ProcessCassetteStatus = "incomplete"
	ProcessCassetteStatusComplete   ProcessCassetteStatus = "complete"
)

type ProcessCassetteManifest struct {
	SchemaVersion     int                                 `json:"schemaVersion"`
	ProjectionVersion int                                 `json:"projectionVersion"`
	Status            ProcessCassetteStatus               `json:"status"`
	FrameCount        uint64                              `json:"frameCount"`
	PayloadBytes      uint64                              `json:"payloadBytes"`
	StoredBytes       uint64                              `json:"storedBytes"`
	MaxFrameBytes     uint64                              `json:"maxFrameBytes"`
	Limits            ProcessCassetteLimits               `json:"limits"`
	FramesByKind      map[string]ProcessCassetteKindStats `json:"framesByKind"`
	FramesSHA256      string                              `json:"framesSha256"`
	Connections       []ProcessCassetteConnectionRecord   `json:"connections"`
}

type ProcessCassetteLimits struct {
	MaxFrameBytes  uint64 `json:"maxFrameBytes"`
	MaxStoredBytes uint64 `json:"maxStoredBytes"`
}

type ProcessCassetteKindStats struct {
	FrameCount   uint64 `json:"frameCount"`
	PayloadBytes uint64 `json:"payloadBytes"`
	StoredBytes  uint64 `json:"storedBytes"`
}

type ProcessCassetteCaptureOrigin string

const (
	ProcessCassetteCaptureOriginProcessStart           ProcessCassetteCaptureOrigin = "process-start"
	ProcessCassetteCaptureOriginAttachedLiveConnection ProcessCassetteCaptureOrigin = "attached-live-connection"
)

type ProcessCassetteConnectionRecord struct {
	ConnectionID       string                       `json:"connectionId"`
	Provider           string                       `json:"provider"`
	AgentSessionID     string                       `json:"agentSessionId"`
	RootAgentSessionID string                       `json:"rootAgentSessionId"`
	LaunchOrdinal      uint64                       `json:"launchOrdinal"`
	CWDToken           string                       `json:"cwdToken"`
	CaptureOrigin      ProcessCassetteCaptureOrigin `json:"captureOrigin"`
}

type ProcessCassetteChunk struct {
	ConnectionID string `json:"connectionId"`
	ChunkSeq     uint64 `json:"chunkSeq"`
	GlobalSeq    uint64 `json:"globalSeq"`
	ElapsedMS    int64  `json:"elapsedMs"`
	Kind         string `json:"kind"`
	Data         string `json:"data,omitempty"`
	ExitCode     *int   `json:"exitCode,omitempty"`
	Message      string `json:"message,omitempty"`
}

func IsProviderPathField(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "cwd", "cwds", "path", "paths", "projectpath", "project_path",
		"savedpath", "savedpaths", "workingdirectory", "working_directory",
		"statedirectory", "state_directory":
		return true
	default:
		return false
	}
}

// AuditProjectedProcessCassetteFrames verifies a Provider tape using the
// registered adapter for each manifest connection. Connections are required so
// audit policy cannot silently fall back to another Provider's protocol rules.
func AuditProjectedProcessCassetteFrames(
	reader io.Reader,
	connections []ProcessCassetteConnectionRecord,
) error {
	providers := make(map[string]ProviderReplayDescriptor, len(connections))
	for _, connection := range connections {
		descriptor, ok := FindProviderReplayByProvider(connection.Provider)
		if !ok {
			return fmt.Errorf(
				"projected process cassette provider %q has no replay adapter",
				connection.Provider,
			)
		}
		if descriptor.Tape.AuditCodec != ProviderAuditCodecJSONRPCPortable &&
			descriptor.Tape.AuditCodec != ProviderAuditCodecClaudeSidecarV7Portable {
			return fmt.Errorf(
				"projected process cassette provider %q has unsupported audit codec %q",
				connection.Provider,
				descriptor.Tape.AuditCodec,
			)
		}
		providers[connection.ConnectionID] = descriptor
	}
	streams := map[string]*bytes.Buffer{}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for line := 1; scanner.Scan(); line++ {
		var chunk ProcessCassetteChunk
		if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
			return fmt.Errorf("decode projected process cassette line %d: %w", line, err)
		}
		switch chunk.Kind {
		case "outbound", "stdout", "stderr":
		default:
			continue
		}
		data, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			return fmt.Errorf(
				"decode projected process cassette %s line %d: %w",
				chunk.Kind,
				line,
				err,
			)
		}
		key := chunk.ConnectionID + "\x00" + chunk.Kind
		if streams[key] == nil {
			streams[key] = &bytes.Buffer{}
		}
		if uint64(streams[key].Len()+len(data)) > uint64(MaxProviderTapeBytes) {
			return ErrProcessCassetteSizeLimit
		}
		_, _ = streams[key].Write(data)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read projected process cassette frames: %w", err)
	}

	for key, stream := range streams {
		connectionID := processCassetteStreamConnectionID(key)
		descriptor, ok := providers[connectionID]
		if !ok {
			return fmt.Errorf(
				"projected process cassette connection %q has no replay adapter",
				connectionID,
			)
		}
		values, ok := decodeProcessCassetteJSONValues(stream.Bytes())
		if !ok {
			if processCassetteStreamKind(key) == "stderr" {
				continue
			}
			return errors.New("projected process cassette contains invalid protocol JSON")
		}
		for _, value := range values {
			if message, ok := value.(map[string]any); ok {
				method, _ := message["method"].(string)
				if descriptor.MethodCarriesCredentials(method) {
					return fmt.Errorf(
						"projected process cassette contains credential-bearing method %q",
						method,
					)
				}
			}
			if err := AuditProjectedProcessCassetteValue("$", "", value); err != nil {
				return err
			}
		}
	}
	return nil
}

func processCassetteStreamConnectionID(key string) string {
	for index := len(key) - 1; index >= 0; index-- {
		if key[index] == 0 {
			return key[:index]
		}
	}
	return key
}

// AuditProjectedProcessCassetteValue rejects sensitive fields and absolute
// paths from one projected Provider protocol value.
func AuditProjectedProcessCassetteValue(path, key string, value any) error {
	switch typed := value.(type) {
	case map[string]any:
		for childKey, child := range typed {
			childPath := path + "." + childKey
			if processCassetteSensitiveField(childKey, child) {
				return fmt.Errorf(
					"process cassette projection rejected sensitive field %s",
					childPath,
				)
			}
			if IsProviderPathField(childKey) &&
				containsAbsoluteProcessCassettePath(child) {
				return fmt.Errorf(
					"process cassette projection rejected non-portable path at %s",
					childPath,
				)
			}
			if err := AuditProjectedProcessCassetteValue(childPath, childKey, child); err != nil {
				return err
			}
		}
	case []any:
		for index, child := range typed {
			if err := AuditProjectedProcessCassetteValue(
				fmt.Sprintf("%s[%d]", path, index),
				key,
				child,
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func decodeProcessCassetteJSONValues(data []byte) ([]any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var values []any
	for {
		var value any
		if err := decoder.Decode(&value); err != nil {
			return values, errors.Is(err, io.EOF) && len(values) > 0
		}
		values = append(values, value)
	}
}

func processCassetteStreamKind(key string) string {
	for index := len(key) - 1; index >= 0; index-- {
		if key[index] == 0 {
			return key[index+1:]
		}
	}
	return key
}

func processCassetteSensitiveField(key string, value any) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	switch normalized {
	case "email":
		email, _ := value.(string)
		return strings.TrimSpace(email) != "" &&
			email != "replay-user@example.invalid"
	case "accesstoken", "refreshtoken", "apikey", "authorization":
		switch typed := value.(type) {
		case string:
			return strings.TrimSpace(typed) != ""
		case map[string]any, []any:
			return true
		default:
			return false
		}
	case "chatgptaccountid", "accountid", "creatoraccountuserid":
		return processCassetteSensitiveValuePresent(value)
	default:
		return false
	}
}

func processCassetteSensitiveValuePresent(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(typed) != ""
	default:
		return true
	}
}

func containsAbsoluteProcessCassettePath(value any) bool {
	switch typed := value.(type) {
	case string:
		candidate := strings.TrimPrefix(strings.TrimSpace(typed), "file://")
		return strings.HasPrefix(candidate, "/") ||
			strings.HasPrefix(candidate, `\`) ||
			(len(candidate) >= 3 &&
				((candidate[0] >= 'a' && candidate[0] <= 'z') ||
					(candidate[0] >= 'A' && candidate[0] <= 'Z')) &&
				candidate[1] == ':' &&
				(candidate[2] == '/' || candidate[2] == '\\'))
	case []any:
		for _, child := range typed {
			if containsAbsoluteProcessCassettePath(child) {
				return true
			}
		}
	}
	return false
}
