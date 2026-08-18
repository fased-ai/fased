package webauthn

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestConfigurationIsExactAndFailClosed(t *testing.T) {
	if _, err := New("", "https://wallet.example.test"); err == nil || err.Error() != "WebAuthn requires both --webauthn-rp-id and --webauthn-origins" {
		t.Fatalf("partial configuration error = %v", err)
	}
	if _, err := New("wallet.example.test", "http://wallet.example.test"); err == nil || !strings.Contains(err.Error(), "must use HTTPS") {
		t.Fatalf("insecure origin error = %v", err)
	}
	if _, err := New("wallet.example.test", "https://attacker.example.net"); err == nil || !strings.Contains(err.Error(), "outside RP ID") {
		t.Fatalf("outside-RP origin error = %v", err)
	}
	disabled, err := New("", "")
	if err != nil || disabled.Enabled() {
		t.Fatalf("empty configuration = enabled=%t err=%v", disabled != nil && disabled.Enabled(), err)
	}
	rp, err := New("wallet.example.test.", "https://b.wallet.example.test,https://wallet.example.test,https://b.wallet.example.test")
	if err != nil {
		t.Fatalf("new relying party: %v", err)
	}
	if got, want := rp.RPID(), "wallet.example.test"; got != want {
		t.Fatalf("RP ID = %q, want %q", got, want)
	}
	origins := rp.Origins()
	if got, want := strings.Join(origins, ","), "https://b.wallet.example.test,https://wallet.example.test"; got != want {
		t.Fatalf("origins = %q, want %q", got, want)
	}
	origins[0] = "https://attacker.example.test"
	if rp.Origins()[0] != "https://b.wallet.example.test" {
		t.Fatal("Origins exposed mutable relying-party configuration")
	}
	options, _, err := rp.BeginRegistration(make([]byte, 32), nil)
	if err != nil {
		t.Fatalf("begin registration: %v", err)
	}
	if options.Response.RelyingParty.ID != "wallet.example.test" {
		t.Fatalf("registration RP ID = %q", options.Response.RelyingParty.ID)
	}
	if got, want := time.Duration(options.Response.Timeout)*time.Millisecond, RegistrationTTL; got != want {
		t.Fatalf("registration timeout = %s, want %s", got, want)
	}
	login, _, err := rp.BeginReviewAuthentication(make([]byte, 32), []Credential{{ID: []byte{1}}})
	if err != nil {
		t.Fatalf("begin review authentication: %v", err)
	}
	if got, want := time.Duration(login.Response.Timeout)*time.Millisecond, ReviewTTL; got != want {
		t.Fatalf("review timeout = %s, want %s", got, want)
	}
}

func TestCeremonyParsingAndUnknownCredentialRejections(t *testing.T) {
	rp, err := New("wallet.example.test", "https://wallet.example.test")
	if err != nil {
		t.Fatalf("new relying party: %v", err)
	}
	if _, err := rp.FinishRegistration(make([]byte, 32), nil, SessionData{}, []byte(`{`)); err == nil || err.Error() != "invalid WebAuthn registration response" {
		t.Fatalf("malformed registration error = %v", err)
	}
	known := []Credential{{ID: []byte{2}}}
	_, session, err := rp.BeginReviewAuthentication(make([]byte, 32), known)
	if err != nil {
		t.Fatalf("begin authentication: %v", err)
	}
	if _, err := rp.FinishReviewAuthentication(make([]byte, 32), known, *session, []byte(`{`)); err == nil || err.Error() != "invalid WebAuthn assertion response" {
		t.Fatalf("malformed assertion error = %v", err)
	}
	response := []byte(`{"id":"AQ","rawId":"AQ","type":"public-key","response":{"clientDataJSON":"` + base64.RawURLEncoding.EncodeToString([]byte(`{}`)) + `","authenticatorData":"` + base64.RawURLEncoding.EncodeToString(make([]byte, 37)) + `","signature":"AQ"}}`)
	if _, err := rp.FinishReviewAuthentication(make([]byte, 32), known, *session, response); err == nil || err.Error() != "unknown signer WebAuthn credential" {
		t.Fatalf("unknown credential error = %v", err)
	}
}
