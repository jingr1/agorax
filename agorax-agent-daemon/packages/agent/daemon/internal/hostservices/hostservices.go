package hostservices

type HostEndpoint struct {
	Transport string `json:"transport,omitempty"`
	Address   string `json:"address,omitempty"`
	Token     string `json:"token,omitempty"`
}
