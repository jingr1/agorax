package main

import "testing"

func TestLoginPrefersTerminalEmulator(t *testing.T) {
	if loginPrefersTerminalEmulator(nil) {
		t.Fatal("empty env should be headless")
	}
	if loginPrefersTerminalEmulator([]string{"AGORAX_LOGIN_HEADLESS=1", "DISPLAY=:0"}) {
		t.Fatal("AGORAX_LOGIN_HEADLESS=1 must force command mode")
	}
	if !loginPrefersTerminalEmulator([]string{"DISPLAY=:0"}) {
		t.Fatal("DISPLAY should prefer terminal")
	}
	if !loginPrefersTerminalEmulator([]string{"WAYLAND_DISPLAY=wayland-0"}) {
		t.Fatal("WAYLAND_DISPLAY should prefer terminal")
	}
	if !loginPrefersTerminalEmulator([]string{"AGORAX_LOGIN_TERMINAL=xterm"}) {
		t.Fatal("explicit terminal override should prefer terminal")
	}
}
