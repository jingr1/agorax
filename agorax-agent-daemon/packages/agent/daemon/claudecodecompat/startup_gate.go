package claudecodecompat

import "context"

// DefaultStartupGate serializes Claude credential-sensitive probes. Agorax
// hosts that do not share Agorax's Claude credential store use a no-op gate.
var DefaultStartupGate = nopStartupGate{}

type nopStartupGate struct{}

func (nopStartupGate) Acquire(context.Context) error { return nil }
func (nopStartupGate) Release()                      {}
