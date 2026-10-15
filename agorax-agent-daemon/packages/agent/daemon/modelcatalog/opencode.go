package modelcatalog

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/providerregistry"
	"agorax.local/agent-daemon/packages/agent/daemon/runtimecmd"
)

const (
	// OpenCode's first models probe can bootstrap the provider registry before
	// writing stdout; keep the budget aligned with Tutti's host adapter.
	opencodeModelListTimeout   = 30 * time.Second
	opencodeModelCacheTTL      = 5 * time.Minute
	opencodeModelErrorCacheTTL = 30 * time.Second
)

var opencodeModelTokenPattern = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*`)

type openCodeModelCacheEntry struct {
	models    []ModelOption
	err       error
	expiresAt time.Time
}

var (
	openCodeModelCacheMu sync.Mutex
	openCodeModelCache   openCodeModelCacheEntry
)

// OpenCodeCLIModelLister lists models the same way OpenCode itself does:
// prefer `opencode api GET /api/model` (rich JSON + variants), then fall back
// to `opencode models` (provider/model lines).
type OpenCodeCLIModelLister struct {
	Command string
	Timeout time.Duration
	Environ func() []string
	HomeDir func() (string, error)
	// LookPath overrides binary resolution in tests.
	LookPath func(file string) (string, error)
	// RunCommand overrides process launch in tests. When nil, exec.CommandContext is used.
	RunCommand func(ctx context.Context, name string, args ...string) (stdout []byte, err error)
}

func loadOpenCodeModelsFromCLI() []ModelOption {
	lister := OpenCodeCLIModelLister{}
	models, err := lister.ListModels(context.Background())
	if err != nil || len(models) == 0 {
		return nil
	}
	return models
}

func (l OpenCodeCLIModelLister) ListModels(ctx context.Context) ([]ModelOption, error) {
	if cached, ok := readOpenCodeModelCache(); ok {
		return cloneModelOptions(cached.models), cached.err
	}

	timeout := l.Timeout
	if timeout <= 0 {
		timeout = opencodeModelListTimeout
	}
	processCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	command := l.resolveCommand()
	// Composer must match ACP session/prompt. The local HTTP service and even
	// `opencode models` under zen still advertise registry ids (exo-free) that
	// ACP rejects. Prefer a short ACP session/new probe under the zen auth
	// overlay; fall back to zen CLI lists only when ACP is unavailable.
	zenLister := l.withZenAuthOverlayEnviron()
	var models []ModelOption
	var err error
	// Tests inject RunCommand for api/models; skip the live ACP probe there.
	if l.RunCommand == nil {
		models, err = zenLister.listViaACP(processCtx, command)
	}
	if err != nil || len(models) == 0 {
		apiModels, apiErr := zenLister.listViaAPI(processCtx, command)
		if len(apiModels) > 0 {
			models, err = apiModels, nil
		} else if err != nil || len(models) == 0 {
			fallback, fallbackErr := zenLister.listViaModelsCLI(processCtx, command)
			if len(fallback) > 0 {
				models, err = fallback, nil
			} else if err == nil {
				if apiErr != nil {
					err = apiErr
				} else {
					err = fallbackErr
				}
			}
		}
	}
	if err != nil {
		writeOpenCodeModelCache(nil, err, opencodeModelErrorCacheTTL)
		return nil, err
	}
	if len(models) == 0 {
		err = fmt.Errorf("opencode models returned no provider/model entries")
		writeOpenCodeModelCache(nil, err, opencodeModelErrorCacheTTL)
		return nil, err
	}
	writeOpenCodeModelCache(models, nil, opencodeModelCacheTTL)
	return cloneModelOptions(models), nil
}

func (l OpenCodeCLIModelLister) withZenAuthOverlayEnviron() OpenCodeCLIModelLister {
	base := l
	base.Environ = func() []string {
		var inherited []string
		if l.Environ != nil {
			inherited = l.Environ()
		} else {
			inherited = runtimecmd.Resolver{HomeDir: l.HomeDir}.Env(nil)
		}
		env, err := openCodeZenListEnviron(inherited)
		if err != nil {
			return inherited
		}
		return env
	}
	return base
}

func (l OpenCodeCLIModelLister) resolveCommand() string {
	command := strings.TrimSpace(l.Command)
	if command == "" {
		command = "opencode"
	}
	resolver := runtimecmd.Resolver{
		Environ: l.Environ,
		HomeDir: l.HomeDir,
	}
	if l.LookPath != nil {
		resolver.LookPath = l.LookPath
	}
	env := resolver.Env(nil)
	return resolver.Resolve(command, env)
}

func (l OpenCodeCLIModelLister) listViaHTTPService(ctx context.Context) ([]ModelOption, error) {
	baseURL, password, err := resolveOpenCodeServiceEndpoint(l.HomeDir)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 8 * time.Second}
	body, err := getOpenCodeServiceJSON(ctx, client, baseURL, password, "/api/model")
	if err != nil {
		return nil, err
	}
	models := parseOpenCodeAPIModelList(body)
	if len(models) == 0 {
		return nil, fmt.Errorf("opencode service /api/model returned no models")
	}
	defaultID := ""
	if defaultBody, defaultErr := getOpenCodeServiceJSON(ctx, client, baseURL, password, "/api/model/default"); defaultErr == nil {
		defaultID = parseOpenCodeAPIDefaultModelID(defaultBody)
	}
	return markOpenCodeDefaultModel(models, defaultID), nil
}

func (l OpenCodeCLIModelLister) listViaAPI(ctx context.Context, command string) ([]ModelOption, error) {
	output, err := l.run(ctx, command, "--log-level", "none", "api", "GET", "/api/model")
	if err != nil {
		return nil, err
	}
	models := parseOpenCodeAPIModelList(output)
	if len(models) == 0 {
		return nil, fmt.Errorf("opencode api GET /api/model returned no models")
	}
	defaultID := ""
	if defaultOutput, defaultErr := l.run(ctx, command, "--log-level", "none", "api", "GET", "/api/model/default"); defaultErr == nil {
		defaultID = parseOpenCodeAPIDefaultModelID(defaultOutput)
	}
	return markOpenCodeDefaultModel(models, defaultID), nil
}

func (l OpenCodeCLIModelLister) listViaModelsCLI(ctx context.Context, command string) ([]ModelOption, error) {
	output, err := l.run(ctx, command, "--log-level", "none", "models")
	if err != nil {
		return nil, err
	}
	models := parseOpenCodeModelsOutput(output)
	if len(models) == 0 {
		return nil, fmt.Errorf("opencode models returned no provider/model entries")
	}
	return models, nil
}

func openCodeZenListEnviron(inherited []string) ([]string, error) {
	overlay, err := ensureOpenCodeZenAuthOverlayDir()
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(inherited)+1)
	for _, item := range inherited {
		key, _, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "XDG_DATA_HOME") {
			continue
		}
		result = append(result, item)
	}
	return append(result, "XDG_DATA_HOME="+overlay), nil
}

func ensureOpenCodeZenAuthOverlayDir() (string, error) {
	base := strings.TrimSpace(os.Getenv("AGORAX_OPENCODE_ZEN_AUTH_OVERLAY"))
	if base == "" {
		cache := strings.TrimSpace(os.Getenv("XDG_CACHE_HOME"))
		if cache == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", fmt.Errorf("resolve OpenCode zen auth overlay home: %w", err)
			}
			cache = filepath.Join(home, ".cache")
		}
		base = filepath.Join(cache, "agorax", "opencode-zen-auth-overlay")
	}
	opencodeDir := filepath.Join(base, "opencode")
	if err := os.MkdirAll(opencodeDir, 0o700); err != nil {
		return "", fmt.Errorf("create OpenCode zen auth overlay: %w", err)
	}
	authPath := filepath.Join(opencodeDir, "auth.json")
	if err := os.WriteFile(authPath, []byte("{}\n"), 0o600); err != nil {
		return "", fmt.Errorf("write OpenCode zen auth overlay: %w", err)
	}
	return base, nil
}

// listViaACP starts a throwaway OpenCode ACP session under the configured env
// and reads the model config options advertised for session/prompt.
func (l OpenCodeCLIModelLister) listViaACP(ctx context.Context, command string) ([]ModelOption, error) {
	cmd := exec.CommandContext(ctx, command, "acp")
	if l.Environ != nil {
		cmd.Env = l.Environ()
	} else {
		cmd.Env = runtimecmd.Resolver{HomeDir: l.HomeDir}.Env(nil)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("start opencode acp: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	writeACP := func(payload map[string]any) error {
		data, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return marshalErr
		}
		_, writeErr := stdin.Write(append(data, '\n'))
		return writeErr
	}
	if err := writeACP(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion":    1,
			"clientCapabilities": map[string]any{},
			"clientInfo":         map[string]any{"name": "agorax-modelcatalog", "version": "0"},
		},
	}); err != nil {
		return nil, err
	}
	_ = writeACP(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	cwd := os.TempDir()
	if err := writeACP(map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params":  map[string]any{"cwd": cwd, "mcpServers": []any{}},
	}); err != nil {
		return nil, err
	}

	type acpLine struct {
		line []byte
		err  error
	}
	lines := make(chan acpLine, 1)
	go func() {
		reader := bufio.NewReader(stdout)
		for {
			line, readErr := reader.ReadBytes('\n')
			lines <- acpLine{line: line, err: readErr}
			if readErr != nil {
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case item := <-lines:
			if item.err != nil && len(item.line) == 0 {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return nil, fmt.Errorf("opencode acp stdout closed: %w", item.err)
			}
			var message struct {
				ID     any            `json:"id"`
				Result map[string]any `json:"result"`
				Error  any            `json:"error"`
			}
			if err := json.Unmarshal(item.line, &message); err != nil {
				continue
			}
			idNum, _ := message.ID.(float64)
			if int(idNum) != 2 || message.Result == nil {
				continue
			}
			if message.Error != nil {
				return nil, fmt.Errorf("opencode acp session/new failed: %v", message.Error)
			}
			models := parseOpenCodeACPModelOptions(message.Result)
			if len(models) == 0 {
				return nil, fmt.Errorf("opencode acp session/new advertised no models")
			}
			return models, nil
		}
	}
}

func parseOpenCodeACPModelOptions(result map[string]any) []ModelOption {
	rawOptions, _ := result["configOptions"].([]any)
	for _, raw := range rawOptions {
		option, _ := raw.(map[string]any)
		if strings.TrimSpace(stringFromAny(option["id"])) != "model" {
			continue
		}
		current := strings.TrimSpace(stringFromAny(option["currentValue"]))
		entries, _ := option["options"].([]any)
		models := make([]ModelOption, 0, len(entries))
		for _, entryRaw := range entries {
			entry, _ := entryRaw.(map[string]any)
			id := strings.TrimSpace(stringFromAny(entry["value"]))
			if id == "" {
				continue
			}
			name := strings.TrimSpace(stringFromAny(entry["name"]))
			models = append(models, ModelOption{
				ID:          id,
				DisplayName: openCodeModelDisplayName(id, name),
				IsDefault:   strings.EqualFold(id, current),
			})
		}
		sort.SliceStable(models, func(left, right int) bool {
			return strings.Compare(models[left].ID, models[right].ID) < 0
		})
		if current != "" {
			models = markOpenCodeDefaultModel(models, current)
		} else if len(models) > 0 {
			models[0].IsDefault = true
		}
		return models
	}
	return nil
}

func (l OpenCodeCLIModelLister) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if l.RunCommand != nil {
		return l.RunCommand(ctx, name, args...)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	if l.Environ != nil {
		cmd.Env = l.Environ()
	} else {
		cmd.Env = runtimecmd.Resolver{HomeDir: l.HomeDir}.Env(nil)
	}
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			output = append(output, exitErr.Stderr...)
		}
		return nil, fmt.Errorf("run %s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func resolveOpenCodeServiceEndpoint(homeDirFn func() (string, error)) (baseURL string, password string, err error) {
	home := ""
	if homeDirFn != nil {
		home, err = homeDirFn()
	} else {
		home, err = os.UserHomeDir()
	}
	if err != nil || strings.TrimSpace(home) == "" {
		return "", "", fmt.Errorf("resolve OpenCode home: %w", err)
	}
	configDir := filepath.Join(home, ".config", "opencode")
	if custom := strings.TrimSpace(os.Getenv("OPENCODE_CONFIG_DIR")); custom != "" {
		configDir = custom
	}
	data, readErr := os.ReadFile(filepath.Join(configDir, "service.json"))
	if readErr != nil {
		return "", "", readErr
	}
	var service struct {
		Password string `json:"password"`
		URL      string `json:"url"`
		Port     int    `json:"port"`
	}
	if err := json.Unmarshal(data, &service); err != nil {
		return "", "", err
	}
	password = strings.TrimSpace(service.Password)
	if password == "" {
		return "", "", fmt.Errorf("opencode service.json missing password")
	}
	baseURL = strings.TrimRight(strings.TrimSpace(service.URL), "/")
	if baseURL == "" && service.Port > 0 {
		baseURL = fmt.Sprintf("http://127.0.0.1:%d", service.Port)
	}
	if baseURL == "" {
		// OpenCode's default local bind when service.json only stores the password.
		baseURL = "http://127.0.0.1:49374"
	}
	return baseURL, password, nil
}

func getOpenCodeServiceJSON(
	ctx context.Context,
	client *http.Client,
	baseURL string,
	password string,
	path string,
) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth("opencode", password)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("opencode service %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

func readOpenCodeModelCache() (openCodeModelCacheEntry, bool) {
	openCodeModelCacheMu.Lock()
	defer openCodeModelCacheMu.Unlock()
	if openCodeModelCache.expiresAt.IsZero() || time.Now().After(openCodeModelCache.expiresAt) {
		return openCodeModelCacheEntry{}, false
	}
	return openCodeModelCacheEntry{
		models:    cloneModelOptions(openCodeModelCache.models),
		err:       openCodeModelCache.err,
		expiresAt: openCodeModelCache.expiresAt,
	}, true
}

func writeOpenCodeModelCache(models []ModelOption, err error, ttl time.Duration) {
	openCodeModelCacheMu.Lock()
	defer openCodeModelCacheMu.Unlock()
	openCodeModelCache = openCodeModelCacheEntry{
		models:    cloneModelOptions(models),
		err:       err,
		expiresAt: time.Now().Add(ttl),
	}
}

func resetOpenCodeModelCacheForTest() {
	openCodeModelCacheMu.Lock()
	defer openCodeModelCacheMu.Unlock()
	openCodeModelCache = openCodeModelCacheEntry{}
}

func cloneModelOptions(models []ModelOption) []ModelOption {
	if len(models) == 0 {
		return nil
	}
	out := make([]ModelOption, 0, len(models))
	for _, model := range models {
		out = append(out, cloneModelOption(model))
	}
	return out
}

func parseOpenCodeAPIModelList(output []byte) []ModelOption {
	var envelope struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(output, &envelope); err != nil || len(envelope.Data) == 0 {
		// Some CLI builds print the bare array.
		var bare []map[string]any
		if err := json.Unmarshal(output, &bare); err != nil || len(bare) == 0 {
			return nil
		}
		envelope.Data = bare
	}
	models := make([]ModelOption, 0, len(envelope.Data))
	for _, entry := range envelope.Data {
		model := normalizeOpenCodeAPIModel(entry)
		if strings.TrimSpace(model.ID) == "" {
			continue
		}
		models = append(models, model)
	}
	sort.SliceStable(models, func(left, right int) bool {
		return strings.Compare(models[left].ID, models[right].ID) < 0
	})
	return models
}

func parseOpenCodeAPIDefaultModelID(output []byte) string {
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(output, &envelope); err != nil || envelope.Data == nil {
		var bare map[string]any
		if err := json.Unmarshal(output, &bare); err != nil {
			return ""
		}
		envelope.Data = bare
	}
	return openCodeModelIDFromFields(envelope.Data)
}

func normalizeOpenCodeAPIModel(entry map[string]any) ModelOption {
	modelID := openCodeModelIDFromFields(entry)
	name := strings.TrimSpace(stringFromAny(entry["name"]))
	displayName := openCodeModelDisplayName(modelID, name)
	variants, variantsAdvertised := entry["variants"].([]any)
	reasoningEfforts := make([]ReasoningEffortOption, 0, len(variants))
	for _, raw := range variants {
		variant, _ := raw.(map[string]any)
		value := strings.TrimSpace(stringFromAny(variant["id"]))
		if value == "" {
			settings, _ := variant["settings"].(map[string]any)
			value = strings.TrimSpace(stringFromAny(settings["reasoningEffort"]))
		}
		if value != "" && providerregistry.OpenCodeModelSupportsReasoningEffort(modelID, value) {
			reasoningEfforts = append(reasoningEfforts, ReasoningEffortOption{Value: value, Label: value})
		}
	}
	sort.SliceStable(reasoningEfforts, func(left, right int) bool {
		return openCodeReasoningEffortOrder(reasoningEfforts[left].Value) < openCodeReasoningEffortOrder(reasoningEfforts[right].Value)
	})
	var supportsImageInput *bool
	if capabilities, ok := entry["capabilities"].(map[string]any); ok {
		switch input := capabilities["input"].(type) {
		case []any:
			for _, item := range input {
				if strings.EqualFold(strings.TrimSpace(stringFromAny(item)), "image") {
					value := true
					supportsImageInput = &value
					break
				}
			}
			if supportsImageInput == nil {
				value := false
				supportsImageInput = &value
			}
		case map[string]any:
			if image, ok := input["image"].(bool); ok {
				supportsImageInput = &image
			}
		}
	}
	defaultEffort := ""
	if len(reasoningEfforts) > 0 {
		defaultEffort = reasoningEfforts[0].Value
		reasoningEfforts[0].Default = true
	}
	return ModelOption{
		ID:                         modelID,
		DisplayName:                displayName,
		Description:                "OpenCode model",
		DefaultReasoningEffort:     defaultEffort,
		ReasoningEffortsAdvertised: variantsAdvertised,
		SupportedReasoningEfforts:  reasoningEfforts,
		SupportsImageInput:         supportsImageInput,
	}
}

func openCodeModelIDFromFields(entry map[string]any) string {
	providerID := strings.TrimSpace(stringFromAny(entry["providerID"]))
	modelID := strings.TrimSpace(stringFromAny(entry["modelID"]))
	if modelID == "" {
		modelID = strings.TrimSpace(stringFromAny(entry["id"]))
	}
	if providerID != "" && modelID != "" {
		if strings.Contains(modelID, "/") {
			return modelID
		}
		return providerID + "/" + modelID
	}
	return strings.TrimSpace(stringFromAny(entry["id"]))
}

func markOpenCodeDefaultModel(models []ModelOption, defaultID string) []ModelOption {
	defaultID = strings.TrimSpace(defaultID)
	if defaultID == "" || len(models) == 0 {
		return models
	}
	found := false
	for i := range models {
		if models[i].ID == defaultID {
			models[i].IsDefault = true
			found = true
		} else {
			models[i].IsDefault = false
		}
	}
	if !found {
		models = append([]ModelOption{{
			ID:          defaultID,
			DisplayName: defaultID,
			IsDefault:   true,
		}}, models...)
	}
	return models
}

func parseOpenCodeModelsOutput(output []byte) []ModelOption {
	if models := parseVerboseOpenCodeModelsOutput(output); len(models) > 0 {
		return models
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	modelsByID := map[string]ModelOption{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		for _, token := range opencodeModelTokenPattern.FindAllString(line, -1) {
			modelID := strings.TrimSpace(token)
			if modelID == "" {
				continue
			}
			modelsByID[modelID] = ModelOption{
				ID:          modelID,
				DisplayName: openCodeModelDisplayName(modelID, ""),
				Description: "OpenCode model",
			}
		}
	}
	models := make([]ModelOption, 0, len(modelsByID))
	for _, model := range modelsByID {
		models = append(models, model)
	}
	sort.SliceStable(models, func(left, right int) bool {
		return strings.Compare(models[left].ID, models[right].ID) < 0
	})
	return models
}

func parseVerboseOpenCodeModelsOutput(output []byte) []ModelOption {
	lines := bytes.Split(output, []byte("\n"))
	models := make([]ModelOption, 0)
	for index := 0; index < len(lines); index++ {
		modelID := strings.TrimSpace(string(lines[index]))
		if !opencodeModelTokenPattern.MatchString(modelID) || index+1 >= len(lines) {
			continue
		}
		var block bytes.Buffer
		for index++; index < len(lines); index++ {
			block.Write(lines[index])
			block.WriteByte('\n')
			var metadata map[string]any
			if json.Unmarshal(block.Bytes(), &metadata) != nil {
				continue
			}
			models = append(models, normalizeVerboseOpenCodeModel(modelID, metadata))
			break
		}
	}
	if len(models) == 0 {
		return nil
	}
	sort.SliceStable(models, func(left, right int) bool {
		return strings.Compare(models[left].ID, models[right].ID) < 0
	})
	return models
}

func normalizeVerboseOpenCodeModel(modelID string, metadata map[string]any) ModelOption {
	name := strings.TrimSpace(stringFromAny(metadata["name"]))
	displayName := openCodeModelDisplayName(modelID, name)
	variants, variantsAdvertised := metadata["variants"].(map[string]any)
	reasoningEfforts := make([]ReasoningEffortOption, 0, len(variants))
	for value := range variants {
		value = strings.TrimSpace(value)
		if value != "" && providerregistry.OpenCodeModelSupportsReasoningEffort(modelID, value) {
			reasoningEfforts = append(reasoningEfforts, ReasoningEffortOption{Value: value, Label: value})
		}
	}
	sort.SliceStable(reasoningEfforts, func(left, right int) bool {
		return openCodeReasoningEffortOrder(reasoningEfforts[left].Value) < openCodeReasoningEffortOrder(reasoningEfforts[right].Value)
	})
	var supportsImageInput *bool
	if capabilities, ok := metadata["capabilities"].(map[string]any); ok {
		if input, ok := capabilities["input"].(map[string]any); ok {
			if image, ok := input["image"].(bool); ok {
				supportsImageInput = &image
			}
		}
	}
	defaultEffort := ""
	if len(reasoningEfforts) > 0 {
		defaultEffort = reasoningEfforts[0].Value
		reasoningEfforts[0].Default = true
	}
	return ModelOption{
		ID:                         modelID,
		DisplayName:                displayName,
		Description:                "OpenCode model",
		DefaultReasoningEffort:     defaultEffort,
		ReasoningEffortsAdvertised: variantsAdvertised,
		SupportedReasoningEfforts:  reasoningEfforts,
		SupportsImageInput:         supportsImageInput,
	}
}

func openCodeModelDisplayName(modelID string, name string) string {
	modelID = strings.TrimSpace(modelID)
	name = strings.TrimSpace(name)
	providerID, modelName, qualified := strings.Cut(modelID, "/")
	providerID = strings.TrimSpace(providerID)
	if name == "" && qualified {
		name = strings.TrimSpace(modelName)
	}
	if name == "" {
		return modelID
	}
	if !qualified || providerID == "" {
		return name
	}
	if strings.EqualFold(providerID, "opencode") {
		return name
	}
	return name + " / " + providerID
}

func openCodeReasoningEffortOrder(value string) string {
	switch value {
	case "none":
		return "0"
	case "minimal":
		return "1"
	case "low":
		return "2"
	case "medium":
		return "3"
	case "high":
		return "4"
	case "max", "xhigh":
		return "5"
	default:
		return "6:" + value
	}
}

func stringFromAny(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	case float64, bool, json.Number, int, int64:
		return fmt.Sprint(typed)
	default:
		return ""
	}
}
