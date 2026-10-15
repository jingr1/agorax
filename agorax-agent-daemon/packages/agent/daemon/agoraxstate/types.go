package agoraxstate

type HealthResponse struct {
	Service string `json:"service"`
	Status  string `json:"status"`
}
