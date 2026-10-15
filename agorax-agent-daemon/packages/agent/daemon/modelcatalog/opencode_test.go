package modelcatalog

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseOpenCodeModelsOutput(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeModelsOutput([]byte(`
Provider  Model
anthropic claude-sonnet-4-5 anthropic/claude-sonnet-4-5
openai    gpt-5                  openai/gpt-5
duplicate openai/gpt-5
`))

	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2: %#v", len(models), models)
	}
	if models[0].ID != "anthropic/claude-sonnet-4-5" || models[0].IsDefault {
		t.Fatalf("first model = %#v", models[0])
	}
	if models[1].ID != "openai/gpt-5" || models[1].IsDefault {
		t.Fatalf("second model = %#v", models[1])
	}
}

func TestParseOpenCodeAPIModelListUsesProviderPrefixedIDsAndVariants(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeAPIModelList([]byte(`{
  "data": [
    {
      "id": "exo-free",
      "modelID": "exo-free",
      "providerID": "opencode",
      "name": "Exo Free",
      "capabilities": {"input": ["text", "image"]},
      "variants": [{"id": "high", "settings": {"reasoningEffort": "high"}}]
    },
    {
      "id": "gpt-5.4",
      "modelID": "gpt-5.4",
      "providerID": "github-copilot",
      "name": "GPT-5.4",
      "capabilities": {"input": ["text"]},
      "variants": [
        {"id": "low"},
        {"id": "medium"},
        {"id": "high"}
      ]
    }
  ]
}`))

	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2: %#v", len(models), models)
	}
	if models[0].ID != "github-copilot/gpt-5.4" || models[0].DisplayName != "GPT-5.4 / github-copilot" {
		t.Fatalf("copilot model = %#v", models[0])
	}
	if !models[0].ReasoningEffortsAdvertised || len(models[0].SupportedReasoningEfforts) != 3 {
		t.Fatalf("copilot reasoning = %#v", models[0])
	}
	if models[1].ID != "opencode/exo-free" || models[1].DisplayName != "Exo Free" {
		t.Fatalf("opencode model = %#v", models[1])
	}
	if models[1].SupportsImageInput == nil || !*models[1].SupportsImageInput {
		t.Fatalf("exo image support = %#v", models[1].SupportsImageInput)
	}
}

func TestParseVerboseOpenCodeModelsOutputFiltersSparkUnsupportedNoneEffort(t *testing.T) {
	t.Parallel()

	models := parseOpenCodeModelsOutput([]byte(`openai/gpt-5.3-codex-spark
{
  "name": "GPT-5.3 Codex Spark",
  "variants": {
    "none": {"reasoningEffort": "none"},
    "low": {"reasoningEffort": "low"},
    "medium": {"reasoningEffort": "medium"},
    "high": {"reasoningEffort": "high"},
    "xhigh": {"reasoningEffort": "xhigh"}
  }
}
`))
	if len(models) != 1 {
		t.Fatalf("models = %#v, want one Spark model", models)
	}
	want := []string{"low", "medium", "high", "xhigh"}
	if len(models[0].SupportedReasoningEfforts) != len(want) {
		t.Fatalf("Spark reasoning efforts = %#v, want %#v", models[0].SupportedReasoningEfforts, want)
	}
	for index, value := range want {
		if got := models[0].SupportedReasoningEfforts[index].Value; got != value {
			t.Fatalf("Spark reasoning effort[%d] = %q, want %q", index, got, value)
		}
	}
}

func TestOpenCodeCLIModelListerFallsBackToModelsCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is unix-only")
	}
	resetOpenCodeModelCacheForTest()
	t.Cleanup(resetOpenCodeModelCacheForTest)

	emptyHome := t.TempDir()
	calls := []string{}
	lister := OpenCodeCLIModelLister{
		Command: filepath.Join(t.TempDir(), "opencode"),
		HomeDir: func() (string, error) { return emptyHome, nil },
		RunCommand: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, strings.Join(args, " "))
			switch strings.Join(args, " ") {
			case "--log-level none api GET /api/model":
				return nil, context.DeadlineExceeded
			case "--log-level none models":
				return []byte("opencode/big-pickle\ngithub-copilot/gpt-5.4\n"), nil
			default:
				t.Fatalf("unexpected args %#v", args)
				return nil, nil
			}
		},
	}

	models, err := lister.ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if len(models) != 2 || models[0].ID != "github-copilot/gpt-5.4" || models[1].ID != "opencode/big-pickle" {
		t.Fatalf("models = %#v", models)
	}
	if len(calls) != 2 ||
		calls[0] != "--log-level none api GET /api/model" ||
		calls[1] != "--log-level none models" {
		t.Fatalf("calls = %#v", calls)
	}

	// Cached hit must not re-run the CLI.
	calls = nil
	cached, err := lister.ListModels(context.Background())
	if err != nil || len(cached) != 2 {
		t.Fatalf("cached ListModels = (%v, %#v)", err, cached)
	}
	if len(calls) != 0 {
		t.Fatalf("expected cache hit, got calls %#v", calls)
	}
}

func TestLoadLocalProviderModelsOpenCodeUsesLister(t *testing.T) {
	resetOpenCodeModelCacheForTest()
	t.Cleanup(resetOpenCodeModelCacheForTest)

	emptyHome := t.TempDir()
	// Force a deterministic empty miss first, then seed cache via the lister
	// path used by LoadLocalProviderModels.
	lister := OpenCodeCLIModelLister{
		HomeDir: func() (string, error) { return emptyHome, nil },
		RunCommand: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return []byte(`{"data":[{"id":"exo-free","modelID":"exo-free","providerID":"opencode","name":"Exo Free","variants":[]}]}`), nil
		},
	}
	if _, err := lister.ListModels(context.Background()); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	models := LoadLocalProviderModels("opencode")
	if len(models) != 1 || models[0].ID != "opencode/exo-free" {
		t.Fatalf("LoadLocalProviderModels(opencode) = %#v", models)
	}
}

func TestResolveOpenCodeServiceEndpointReadsPassword(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	configDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(configDir, "service.json"),
		[]byte(`{"password":"secret","port":41234}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	baseURL, password, err := resolveOpenCodeServiceEndpoint(func() (string, error) {
		return home, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if password != "secret" || baseURL != "http://127.0.0.1:41234" {
		t.Fatalf("endpoint = (%q, %q)", baseURL, password)
	}
}
