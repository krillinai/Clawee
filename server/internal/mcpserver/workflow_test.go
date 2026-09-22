package mcpserver

import (
	"encoding/json"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/krillinai/Clawee/server/internal/workflow"
)

func TestWorkflowOutputSchemasAcceptJSONObjectInputs(t *testing.T) {
	task := workflow.Task{Input: json.RawMessage(`{"start":"good"}`), Output: json.RawMessage(`{"text":"done"}`)}
	for _, test := range []struct {
		name   string
		schema *jsonschema.Schema
		value  any
	}{
		{"get task", workflowObjectSchema[workflow.Task](true), task},
		{"list tasks with hidden input", workflowObjectSchema[workflowListOutput](true), workflowListOutput{Tasks: []workflow.Task{{Input: nil}}}},
		{"complete task with next task", workflowObjectSchema[workflow.Result](true), workflow.Result{NextTask: &task}},
		{"complete task arguments", workflowObjectSchema[workflowCompleteInput](false), workflowCompleteInput{TaskID: "task", Key: "key", Output: json.RawMessage(`{"text":"done"}`)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolved, err := test.schema.Resolve(nil)
			if err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(test.value)
			if err != nil {
				t.Fatal(err)
			}
			var output any
			if err := json.Unmarshal(data, &output); err != nil {
				t.Fatal(err)
			}
			if err := resolved.Validate(output); err != nil {
				t.Fatalf("MCP output %s: %v", data, err)
			}
		})
	}
}

func TestWorkflowCompleteInputSchemaRejectsArrayOutput(t *testing.T) {
	resolved, err := workflowObjectSchema[workflowCompleteInput](false).Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := resolved.Validate(map[string]any{"task_id": "task", "idempotency_key": "key", "output": []any{"invalid"}}); err == nil {
		t.Fatal("array output passed the workflow completion input schema")
	}
}
