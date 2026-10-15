package modelcatalog

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadLocalProviderModelsClaudeCode(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	settings := `{
  "model": "opus",
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"
  }
}`
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	models := LoadLocalProviderModels("claude-code")
	if len(models) < 3 {
		t.Fatalf("models = %#v, want at least haiku/sonnet/opus", models)
	}
	var foundDefault bool
	for _, model := range models {
		if model.ID == "claude-opus-4-6" && model.IsDefault {
			foundDefault = true
		}
		if !model.ReasoningEffortsAdvertised || len(model.SupportedReasoningEfforts) == 0 {
			t.Fatalf("claude model %q missing reasoning efforts", model.ID)
		}
	}
	if !foundDefault {
		t.Fatalf("expected expanded opus default in %#v", models)
	}
}

func TestLoadLocalProviderModelsCodex(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	config := `
model = "gpt-5.4"
model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
models = ["gpt-5.4", "gpt-5.2", "o3"]
`
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	models := LoadLocalProviderModels("codex")
	if len(models) < 3 {
		t.Fatalf("models = %#v, want current + provider list", models)
	}
	ids := map[string]bool{}
	for _, model := range models {
		ids[model.ID] = true
		if model.ID == "gpt-5.4" && !model.IsDefault {
			t.Fatalf("current model should be default: %#v", models)
		}
	}
	for _, want := range []string{"gpt-5.4", "gpt-5.2", "o3"} {
		if !ids[want] {
			t.Fatalf("missing %s in %#v", want, models)
		}
	}
}

func TestLoadLocalProviderModelsUnknownEmpty(t *testing.T) {
	if models := LoadLocalProviderModels("kimi"); models != nil {
		t.Fatalf("unknown provider should return nil, got %#v", models)
	}
}

func TestProjectComposerCatalogFromLocalClaude(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"model":"claude-sonnet-4-6"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models := LoadLocalProviderModels("local:claude-code")
	projection := ProjectComposerCatalog(models, "")
	if !projection.Selection.Found || projection.Selection.Model.ID != "claude-sonnet-4-6" {
		t.Fatalf("selection = %#v", projection.Selection)
	}
	if len(projection.ReasoningOptionsByModel["claude-sonnet-4-6"].Options) == 0 {
		t.Fatalf("expected reasoning options, got %#v", projection.ReasoningOptionsByModel)
	}
}
