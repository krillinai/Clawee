package businessdata

import "strings"

type ConnectorRegistry struct {
	connectors map[string]Connector
}

func NewConnectorRegistry() *ConnectorRegistry {
	return &ConnectorRegistry{connectors: make(map[string]Connector)}
}

func (r *ConnectorRegistry) Register(connector Connector) error {
	if r == nil || connector == nil {
		return ErrInvalidRequest
	}
	provider := strings.TrimSpace(connector.Provider())
	if !validProvider(provider) {
		return ErrInvalidRequest
	}
	if r.connectors == nil {
		r.connectors = make(map[string]Connector)
	}
	if _, exists := r.connectors[provider]; exists {
		return ErrInvalidRequest
	}
	r.connectors[provider] = connector
	return nil
}

func (r *ConnectorRegistry) Get(provider string) (Connector, bool) {
	if r == nil {
		return nil, false
	}
	connector, ok := r.connectors[strings.TrimSpace(provider)]
	return connector, ok
}
