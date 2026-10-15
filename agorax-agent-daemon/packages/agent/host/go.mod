module agorax.local/agent-daemon/packages/agent/host

go 1.24.3

toolchain go1.24.5

require (
	github.com/google/uuid v1.6.0
	agorax.local/agent-daemon/packages/agent/store-sqlite v0.0.0
	agorax.local/agent-daemon/packages/agent/store-sqlite/canonical v0.0.0
	modernc.org/sqlite v1.45.0
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	agorax.local/agent-daemon/packages/agent/activity-replication v0.0.0 // indirect
	golang.org/x/exp v0.0.0-20251023183803-a4bb9ffd2546 // indirect
	golang.org/x/mod v0.33.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
	modernc.org/libc v1.67.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)

replace agorax.local/agent-daemon/packages/agent/activity-replication => ../activity-replication

replace agorax.local/agent-daemon/packages/agent/store-sqlite => ../store-sqlite

replace agorax.local/agent-daemon/packages/agent/store-sqlite/canonical => ../store-sqlite/canonical
