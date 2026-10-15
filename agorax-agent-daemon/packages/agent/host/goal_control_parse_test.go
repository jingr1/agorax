package agenthost

import "testing"

func TestParseTypedGoalControlUsesSemanticContentAndUnicodeWhitespace(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    TypedGoalControl
		wantOK  bool
	}{
		{name: "space", content: "/goal clear", want: TypedGoalControl{Action: "clear"}, wantOK: true},
		{name: "tab", content: "/goal\tclear", want: TypedGoalControl{Action: "clear"}, wantOK: true},
		{name: "newline", content: "/goal\nship it", want: TypedGoalControl{Action: "set", Objective: "ship it"}, wantOK: true},
		{name: "unicode space", content: "/goal\u3000ship it", want: TypedGoalControl{Action: "set", Objective: "ship it"}, wantOK: true},
		{name: "ordinary prompt cannot create control", content: "ordinary prompt", wantOK: false},
		{name: "bare goal is not a mutation", content: "/goal", wantOK: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := ParseTypedGoalControl([]PromptContentBlock{{
				Type: "text", Text: test.content,
			}}, false)
			if ok != test.wantOK || got != test.want {
				t.Fatalf("ParseTypedGoalControl() = (%#v, %v), want (%#v, %v)", got, ok, test.want, test.wantOK)
			}
		})
	}
}
