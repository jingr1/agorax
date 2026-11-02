package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

const nodeHeartbeatInterval = 15 * time.Second

type nodeRegistrationConfig struct {
	ControlPlaneURL string
	Token           string
	NodeID          string
	NodeName        string
	NodeURL         string
	WorkspaceID     string
}

func nodeRegistrationConfigFromEnv() (nodeRegistrationConfig, bool) {
	config := nodeRegistrationConfig{
		ControlPlaneURL: strings.TrimRight(strings.TrimSpace(os.Getenv("AGORAX_CONTROL_PLANE_URL")), "/"),
		Token:           strings.TrimSpace(os.Getenv("AGORAX_EXECUTION_NODE_TOKEN")),
		NodeID:          strings.TrimSpace(os.Getenv("AGORAX_EXECUTION_NODE_ID")),
		NodeName:        strings.TrimSpace(os.Getenv("AGORAX_EXECUTION_NODE_NAME")),
		NodeURL:         strings.TrimRight(strings.TrimSpace(os.Getenv("AGORAX_EXECUTION_NODE_URL")), "/"),
		WorkspaceID:     strings.TrimSpace(os.Getenv("AGORAX_WORKSPACE_ID")),
	}
	if config.ControlPlaneURL == "" && config.NodeID == "" && config.NodeURL == "" {
		return nodeRegistrationConfig{}, false
	}
	if config.ControlPlaneURL == "" || config.Token == "" || config.NodeID == "" || config.NodeURL == "" {
		return nodeRegistrationConfig{}, false
	}
	if config.NodeName == "" {
		config.NodeName = config.NodeID
	}
	if config.WorkspaceID == "" {
		config.WorkspaceID = "default"
	}
	return config, true
}

func runNodeRegistrationLoop(ctx context.Context, config nodeRegistrationConfig, capabilities func() []string) {
	client := &http.Client{Timeout: 10 * time.Second}
	registered := false
	register := func() {
		method := http.MethodPatch
		payload := map[string]any{"id": config.NodeID, "capabilities": capabilities()}
		if !registered {
			method = http.MethodPost
			payload["name"] = config.NodeName
			payload["baseUrl"] = config.NodeURL
			payload["workspaceId"] = config.WorkspaceID
		}
		if err := sendNodeRegistration(ctx, client, config, method, payload); err != nil {
			registered = false
			fmt.Fprintf(os.Stderr, "agorax-agentd: execution node registration: %v\n", err)
			return
		}
		registered = true
	}

	register()
	ticker := time.NewTicker(nodeHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			register()
		}
	}
}

func sendNodeRegistration(
	ctx context.Context,
	client *http.Client,
	config nodeRegistrationConfig,
	method string,
	payload map[string]any,
) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		config.ControlPlaneURL+"/api/execution-nodes",
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+config.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("control plane returned %s", response.Status)
	}
	return nil
}
