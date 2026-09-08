package mcpgateway

import "testing"

func TestSchemaHashIsStableForEquivalentMaps(t *testing.T) {
	left := JSONMap{"type": "object", "properties": JSONMap{"keyword": JSONMap{"type": "string"}}}
	right := JSONMap{"properties": JSONMap{"keyword": JSONMap{"type": "string"}}, "type": "object"}

	leftHash, err := SchemaHash(left)
	if err != nil {
		t.Fatalf("left hash: %v", err)
	}
	rightHash, err := SchemaHash(right)
	if err != nil {
		t.Fatalf("right hash: %v", err)
	}
	if leftHash != rightHash {
		t.Fatalf("hash mismatch: %s != %s", leftHash, rightHash)
	}
}

func TestSchemaHashNilMatchesEmptyObjectSchema(t *testing.T) {
	nilHash, err := SchemaHash(nil)
	if err != nil {
		t.Fatalf("nil hash: %v", err)
	}
	emptyObjectHash, err := SchemaHash(JSONMap{"type": "object"})
	if err != nil {
		t.Fatalf("empty object hash: %v", err)
	}
	if nilHash != emptyObjectHash {
		t.Fatalf("hash mismatch: %s != %s", nilHash, emptyObjectHash)
	}
}

func TestValidateInputSchemaRejectsMissingRequiredField(t *testing.T) {
	schema := JSONMap{
		"type":     "object",
		"required": []any{"keyword"},
		"properties": JSONMap{
			"keyword": JSONMap{"type": "string"},
		},
	}

	if err := ValidateInput(schema, JSONMap{"keyword": "acme"}); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	if err := ValidateInput(schema, JSONMap{}); err == nil {
		t.Fatal("missing keyword accepted, want validation error")
	}
}

func TestValidateInputNilSchemaAcceptsJSONMapInput(t *testing.T) {
	if err := ValidateInput(nil, JSONMap{"keyword": "acme"}); err != nil {
		t.Fatalf("nil schema rejected JSONMap input: %v", err)
	}
}

func TestValidateInputEmptyObjectSchemaAcceptsJSONMapInput(t *testing.T) {
	if err := ValidateInput(JSONMap{"type": "object"}, JSONMap{"keyword": "acme"}); err != nil {
		t.Fatalf("empty object schema rejected JSONMap input: %v", err)
	}
}

func TestValidateInputRejectsTypeMismatch(t *testing.T) {
	schema := JSONMap{
		"type": "object",
		"properties": JSONMap{
			"keyword": JSONMap{"type": "string"},
		},
	}

	if err := ValidateInput(schema, JSONMap{"keyword": 123}); err == nil {
		t.Fatal("type mismatch accepted, want validation error")
	}
}

func TestValidateInputRejectsAdditionalPropertiesFalse(t *testing.T) {
	schema := JSONMap{
		"type":                 "object",
		"additionalProperties": false,
		"properties": JSONMap{
			"keyword": JSONMap{"type": "string"},
		},
	}

	if err := ValidateInput(schema, JSONMap{"keyword": "acme", "extra": true}); err == nil {
		t.Fatal("extra field accepted, want validation error")
	}
}

func TestValidateInputMalformedSchemaReturnsError(t *testing.T) {
	if err := ValidateInput(JSONMap{"type": 123}, JSONMap{}); err == nil {
		t.Fatal("malformed schema accepted, want error")
	}
}
