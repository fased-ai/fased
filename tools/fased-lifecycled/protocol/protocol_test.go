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

func TestPublicBridgeRequiresPairedVersionEvidence(t *testing.T) {
	base := Request{SchemaVersion: CurrentSchemaVersion, RequestID: "018f47d2-5a6b-7c8d-9e0f-123456789abc", Operation: OperationConverge, TargetGenerationID: digest, ExpectedManifestDigest: "absent"}
	for _, request := range []Request{
		base,
		func() Request { value := base; value.SourceTopology = "local-user-systemd-v2"; return value }(),
		func() Request { value := base; value.PublicPredecessorVersion = "0.1.75"; return value }(),
		func() Request {
			value := base
			value.SourceTopology = "local-user-systemd-v2"
			value.PublicPredecessorVersion = "invalid"
			return value
		}(),
	} {
		if request.SourceTopology == "" && request.PublicPredecessorVersion == "" {
			if err := request.Validate(); err != nil {
				t.Fatalf("fresh converge was rejected: %v", err)
			}
			continue
		}
		if err := request.Validate(); err == nil {
			t.Fatalf("unpaired or invalid predecessor evidence was accepted: %+v", request)
		}
	}
	bridge := base
	bridge.SourceTopology = "local-user-systemd-v2"
	bridge.PublicPredecessorVersion = "0.1.75"
	if err := bridge.Validate(); err != nil {
		t.Fatalf("valid public predecessor evidence was rejected: %v", err)
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

func TestCompleteOnboardingHasNoCallerControlledSelectors(t *testing.T) {
	input := `{"schemaVersion":1,"requestId":"018f47d2-5a6b-7c8d-9e0f-123456789abc","operation":"COMPLETE_ONBOARDING"}`
	if _, err := DecodeRequest(strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	withTarget := strings.Replace(input, `"operation":"COMPLETE_ONBOARDING"`, `"operation":"COMPLETE_ONBOARDING","targetGenerationId":"`+digest+`"`, 1)
	if _, err := DecodeRequest(strings.NewReader(withTarget)); err == nil {
		t.Fatal("onboarding completion accepted a caller-controlled generation")
	}
}
