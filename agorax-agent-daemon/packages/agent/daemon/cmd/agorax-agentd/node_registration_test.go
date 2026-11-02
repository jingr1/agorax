package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSendNodeRegistration(t *testing.T) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", request.Method)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("authorization = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["id"] != "builder-1" {
			t.Fatalf("id = %v", body["id"])
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	config := nodeRegistrationConfig{ControlPlaneURL: server.URL, Token: "secret"}
	err := sendNodeRegistration(context.Background(), server.Client(), config, http.MethodPost, map[string]any{"id": "builder-1"})
	if err != nil {
		t.Fatal(err)
	}
}
