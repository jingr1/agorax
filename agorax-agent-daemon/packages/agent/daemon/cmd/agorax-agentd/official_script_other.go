//go:build !windows

package main

func officialScriptArgv(scriptShell string, scriptPath string) []string {
	return []string{scriptShell, scriptPath}
}
