package mcpgateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"
)

func SchemaHash(schema JSONMap) (string, error) {
	raw, err := json.Marshal(normalizeSchema(schema))
	if err != nil {
		return "", fmt.Errorf("encode schema: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func ValidateInput(schema JSONMap, input JSONMap) error {
	rawSchema, err := json.Marshal(normalizeSchema(schema))
	if err != nil {
		return fmt.Errorf("encode input schema: %w", err)
	}
	var parsed jsonschema.Schema
	if err := json.Unmarshal(rawSchema, &parsed); err != nil {
		return fmt.Errorf("decode input schema: %w", err)
	}
	resolved, err := parsed.Resolve(nil)
	if err != nil {
		return fmt.Errorf("resolve input schema: %w", err)
	}
	if err := resolved.Validate(input); err != nil {
		return fmt.Errorf("validate input: %w", err)
	}
	return nil
}

func normalizeSchema(schema JSONMap) JSONMap {
	if schema == nil {
		return JSONMap{"type": "object"}
	}
	return schema
}
