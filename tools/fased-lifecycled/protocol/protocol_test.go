package protocol

import (
	"strings"
	"testing"
)

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestStrictRequestAllowsOnlyTypedFixedOperations(t *testing.T) {
	converge := `{
		"schemaVersion":1,
		"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc",
		"operation":"CONVERGE",
		"targetGenerationId":"` + digest + `",
		"expectedManifestDigest":"` + digest + `"
	}`
	request, err := DecodeRequest(strings.NewReader(converge))
	if err != nil || request.Operation != OperationConverge {
		t.Fatalf("valid converge request rejected: %+v err=%v", request, err)
	}

	malicious := strings.Replace(converge, `"operation":"CONVERGE",`, `"operation":"CONVERGE","path":"/tmp/evil","command":"bash",`, 1)
	if _, err := DecodeRequest(strings.NewReader(malicious)); err == nil {
		t.Fatal("request-controlled path or command was accepted")
	}
}

func TestOperationFieldsFailClosed(t *testing.T) {
	tests := []string{
		`{"schemaVersion":2,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","operation":"INSPECT"}`,
		`{"schemaVersion":1,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","operation":"CONVERGE"}`,
		`{"schemaVersion":1,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","operation":"RECOVER"}`,
		`{"schemaVersion":1,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","operation":"SHELL","targetGenerationId":"` + digest + `"}`,
	}
	for _, input := range tests {
		if _, err := DecodeRequest(strings.NewReader(input)); err == nil {
			t.Fatalf("invalid request was accepted: %s", input)
		}
	}
}

func TestInspectHasNoMutationSelectors(t *testing.T) {
	input := `{"schemaVersion":1,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","operation":"INSPECT"}`
	if _, err := DecodeRequest(strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	withTarget := `{"schemaVersion":1,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","operation":"INSPECT","targetGenerationId":"` + digest + `"}`
	if _, err := DecodeRequest(strings.NewReader(withTarget)); err == nil {
		t.Fatal("inspect request accepted a mutation selector")
	}
}
