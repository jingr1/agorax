module agorax.local/agent-daemon/packages/agent/daemon

go 1.25

require (
	agorax.local/agent-daemon/packages/agent/host v0.0.0
	agorax.local/agent-daemon/packages/agent/session-replay v0.0.0
	agorax.local/agent-daemon/packages/agent/store-sqlite/canonical v0.0.0
	github.com/atombender/go-jsonschema v0.20.0
	golang.org/x/net v0.50.0
	golang.org/x/sys v0.41.0
	google.golang.org/protobuf v1.36.11
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/klauspost/compress v1.17.7 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/exp v0.0.0-20251023183803-a4bb9ffd2546 // indirect
	golang.org/x/sync v0.19.0 // indirect
	modernc.org/libc v1.67.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
	modernc.org/sqlite v1.45.0 // indirect
)

require (
	agorax.local/agent-daemon/packages/agent/activity-replication v0.0.0 // indirect
	agorax.local/agent-daemon/packages/agent/store-sqlite v0.0.0 // indirect
	agorax.local/agent-daemon/packages/connector/daemon/core v0.0.0
	dario.cat/mergo v1.0.2 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/goccy/go-yaml v1.17.1 // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mitchellh/go-wordwrap v1.0.1 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/sanity-io/litter v1.5.8 // indirect
	github.com/sosodev/duration v1.3.1 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	golang.org/x/text v0.34.0 // indirect
)

replace google.golang.org/genproto => google.golang.org/genproto v0.0.0-20260120221211-b8f7ae30c516

replace agorax.local/agent-daemon/packages/agent/host => ../host

replace agorax.local/agent-daemon/packages/agent/session-replay => ../session-replay

replace agorax.local/agent-daemon/packages/agent/activity-replication => ../activity-replication

replace agorax.local/agent-daemon/packages/agent/store-sqlite => ../store-sqlite

replace agorax.local/agent-daemon/packages/agent/store-sqlite/canonical => ../store-sqlite/canonical

replace agorax.local/agent-daemon/packages/connector/daemon/core => ../../connector/daemon/core
