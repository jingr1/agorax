package agentruntime

import (
	"context"
	"errors"
)

func (c *Controller) SetProviderGoalAdoptionSink(sink ProviderGoalAdoptionSink) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.providerGoalAdoptionSink = sink
	adapters := make([]Adapter, 0, len(c.adapters))
	for _, adapter := range c.adapters {
		adapters = append(adapters, adapter)
	}
	c.mu.Unlock()
	for _, adapter := range adapters {
		if sinkAdapter, ok := adapter.(ProviderGoalAdoptionSinkAdapter); ok {
			sinkAdapter.SetProviderGoalAdoptionSink(c.adoptProviderGoal)
		}
	}
}

func (c *Controller) adoptProviderGoal(
	ctx context.Context,
	session Session,
	request ProviderGoalAdoptionRequest,
) (GoalProvenanceBinding, error) {
	if c == nil {
		return GoalProvenanceBinding{}, errors.New("provider Goal adoption is unavailable")
	}
	c.mu.Lock()
	sink := c.providerGoalAdoptionSink
	c.mu.Unlock()
	if sink == nil {
		return GoalProvenanceBinding{}, errors.New("provider Goal adoption sink is unavailable")
	}
	return sink(ctx, session, request)
}
